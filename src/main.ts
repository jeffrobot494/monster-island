import * as THREE from 'three';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fc7e0');
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 500);
camera.position.set(40, 50, 40);
camera.lookAt(0, 0, 0);
scene.add(new THREE.AmbientLight(0xffffff, 0.6), new THREE.DirectionalLight(0xffffff, 1));
scene.add(new THREE.Mesh(new THREE.BoxGeometry(10, 1, 10), new THREE.MeshLambertMaterial({ color: '#7cba5a' })));

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => renderer.render(scene, camera));
