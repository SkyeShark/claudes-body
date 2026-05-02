(async () => {
  const { THREE, GLTFLoader } = ClaudeBackend;
  const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('cv'), antialias: true });
  renderer.setSize(540, 640, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 540/640, 0.1, 20);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const dl = new THREE.DirectionalLight(0xffffff, 1.0);
  dl.position.set(0.3, 0.8, 1.5);
  scene.add(dl);

  const loader = new GLTFLoader();
  // NOTE: no VRMLoaderPlugin registered — plain glTF load, no three-vrm normalization
  const gltf = await loader.loadAsync('../assets/claude.vrm');
  scene.add(gltf.scene);

  gltf.scene.updateMatrixWorld(true);
  scene.traverse(o => { if (o.isSkinnedMesh && o.skeleton) o.skeleton.update(); });
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  console.log('[plain] bbox center=', center.x.toFixed(3), center.y.toFixed(3), center.z.toFixed(3));
  console.log('[plain] bbox size  =', size.x.toFixed(3), size.y.toFixed(3), size.z.toFixed(3));
  const fovRad = camera.fov * Math.PI / 180;
  const fitSize = Math.max(size.x, size.y, size.z);
  const dist = (fitSize * 0.5 / Math.tan(fovRad / 2)) * 1.6;
  camera.position.set(center.x, center.y, center.z + dist);
  camera.lookAt(center.x, center.y, center.z);
  camera.near = 0.01;
  camera.far  = dist * 5 + 10;
  camera.updateProjectionMatrix();

  function tick() {
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  tick();
  console.log('[plain] loaded without three-vrm');
})().catch(e => console.error('[plain]', e));
