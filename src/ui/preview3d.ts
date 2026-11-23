// Three.js preview of the plate. The relief is drawn from the same height array that export
// uses: it displaces a plane on the GPU and a normal map carries the fine detail.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ellipseValue, type PlateShape } from '../shapes/outline';

const PLATE_COLOUR = 0xe9e4d8;
/** Most segments along the longer side of the displaced plane. */
const MAX_SEGMENTS = 640;

export class PlatePreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private top: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null;
  private base: THREE.Mesh | null = null;
  private heightTexture: THREE.DataTexture | null = null;
  private normalTexture: THREE.DataTexture | null = null;
  private colourTexture: THREE.DataTexture | null = null;
  private shape: PlateShape | null = null;
  private nx = 0;
  private ny = 0;
  private pending = false;
  /** The user has orbited or zoomed since the view was last fitted. */
  private userMoved = false;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.setAttribute('aria-label', '3D preview of the plate. Drag to rotate.');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.maxPolarAngle = Math.PI * 0.95;
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('start', () => (this.userMoved = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8d939e, 1.0));
    // A low, raking key light is what makes shallow relief readable.
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(-1.0, 0.7, 0.55);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(0.8, -0.6, 0.9);
    this.scene.add(fill);
    this.scene.add(this.group);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Keep the plate framed when the window changes shape, unless the user chose their own view.
    if (!this.userMoved) this.resetView();
    this.invalidate();
  }

  private invalidate(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.renderer.render(this.scene, this.camera);
    });
  }

  /** Point the camera at the plate from the front, tilted, so the whole plate fits. */
  resetView(): void {
    if (!this.shape) return;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fitHeight = this.shape.height / 2 / Math.tan(halfFov);
    const fitWidth = this.shape.width / 2 / (Math.tan(halfFov) * this.camera.aspect);
    const distance = Math.max(fitHeight, fitWidth) * 1.18;
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, -distance * 0.5, distance * 0.87);
    this.camera.near = distance / 100;
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.userMoved = false;
    this.invalidate();
  }

  /** Rebuild geometry and textures for a new plate shape or raster size. */
  setPlate(shape: PlateShape, nx: number, ny: number): void {
    this.disposePlate();
    this.shape = shape;
    this.nx = nx;
    this.ny = ny;

    const longest = Math.max(nx - 1, ny - 1);
    const scale = Math.min(1, MAX_SEGMENTS / longest);
    const geometry = new THREE.PlaneGeometry(
      shape.width,
      shape.height,
      Math.max(2, Math.round((nx - 1) * scale)),
      Math.max(2, Math.round((ny - 1) * scale)),
    );
    // Texture row 0 is the top of the picture; flip v so it lands on the plate's +Y edge.
    const uv = geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));

    this.heightTexture = new THREE.DataTexture(new Uint8Array(nx * ny), nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.minFilter = THREE.LinearFilter;

    const flatNormals = new Uint8Array(nx * ny * 4);
    for (let i = 0; i < nx * ny; i++) {
      flatNormals[i * 4] = 128;
      flatNormals[i * 4 + 1] = 128;
      flatNormals[i * 4 + 2] = 255;
      flatNormals[i * 4 + 3] = 255;
    }
    this.normalTexture = new THREE.DataTexture(flatNormals, nx, ny, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.normalTexture.magFilter = THREE.LinearFilter;
    this.normalTexture.minFilter = THREE.LinearFilter;

    // Colour texture: white (or the depth-band tint), with alpha cutting the plate's outline.
    const colour = new Uint8Array(nx * ny * 4).fill(255);
    this.colourTexture = new THREE.DataTexture(colour, nx, ny, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.colourTexture.colorSpace = THREE.SRGBColorSpace;
    this.colourTexture.magFilter = THREE.LinearFilter;
    this.colourTexture.minFilter = THREE.LinearFilter;
    this.writeColour(null);

    const material = new THREE.MeshStandardMaterial({
      color: PLATE_COLOUR,
      roughness: 0.82,
      metalness: 0,
      map: this.colourTexture,
      alphaTest: 0.5,
      displacementMap: this.heightTexture,
      displacementScale: 1,
      normalMap: this.normalTexture,
    });
    this.top = new THREE.Mesh(geometry, material);
    this.group.add(this.top);
    this.resetView();
  }

  private writeColour(tint: Uint8ClampedArray | null): void {
    if (!this.colourTexture || !this.shape) return;
    const data = this.colourTexture.image.data as Uint8Array;
    const { nx, ny, shape } = this;
    const dx = shape.width / (nx - 1);
    const dy = shape.height / (ny - 1);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const o = (j * nx + i) * 4;
        if (tint) {
          data[o] = tint[o];
          data[o + 1] = tint[o + 1];
          data[o + 2] = tint[o + 2];
        } else {
          data[o] = data[o + 1] = data[o + 2] = 255;
        }
        const inside = !shape.ellipse || ellipseValue(shape, -shape.width / 2 + i * dx, shape.height / 2 - j * dy) <= 1;
        data[o + 3] = inside ? 255 : 0;
      }
    }
    this.colourTexture.needsUpdate = true;
  }

  private setBase(thickness: number): void {
    if (!this.shape) return;
    if (this.base) {
      this.group.remove(this.base);
      this.base.geometry.dispose();
      (this.base.material as THREE.Material).dispose();
    }
    const material = new THREE.MeshStandardMaterial({ color: PLATE_COLOUR, roughness: 0.85, metalness: 0 });
    let geometry: THREE.BufferGeometry;
    if (this.shape.ellipse) {
      geometry = new THREE.CylinderGeometry(1, 1, thickness, 160);
      geometry.rotateX(Math.PI / 2);
      geometry.scale(this.shape.width / 2, this.shape.height / 2, 1);
    } else {
      geometry = new THREE.BoxGeometry(this.shape.width, this.shape.height, thickness);
    }
    this.base = new THREE.Mesh(geometry, material);
    // Sit just under the relief surface so the two never fight for the same pixels.
    this.base.position.z = -thickness / 2 - 0.01;
    this.base.userData.thickness = thickness;
    this.group.add(this.base);
  }

  /**
   * Show new heights. `heights` are mm above the base, `reliefHeight` is the tallest they can be.
   */
  update(heights: Float32Array, reliefHeight: number, baseThickness: number, tint: Uint8ClampedArray | null): void {
    if (!this.top || !this.heightTexture || !this.normalTexture || !this.shape) return;
    const { nx, ny, shape } = this;
    if (heights.length !== nx * ny) return;
    const scale = reliefHeight > 0 ? 255 / reliefHeight : 0;
    const heightData = this.heightTexture.image.data as Uint8Array;
    for (let i = 0; i < heightData.length; i++) heightData[i] = Math.min(255, Math.round(heights[i] * scale));
    this.heightTexture.needsUpdate = true;
    this.top.material.displacementScale = reliefHeight;

    // Tangent-space normals from height differences, in real millimetres.
    const normalData = this.normalTexture.image.data as Uint8Array;
    const invDx = (nx - 1) / shape.width / 2;
    const invDy = (ny - 1) / shape.height / 2;
    for (let j = 0; j < ny; j++) {
      const up = j > 0 ? j - 1 : j;
      const down = j < ny - 1 ? j + 1 : j;
      for (let i = 0; i < nx; i++) {
        const left = i > 0 ? i - 1 : i;
        const right = i < nx - 1 ? i + 1 : i;
        const sx = (heights[j * nx + right] - heights[j * nx + left]) * invDx;
        const sy = (heights[down * nx + i] - heights[up * nx + i]) * invDy;
        const inv = 1 / Math.sqrt(sx * sx + sy * sy + 1);
        const o = (j * nx + i) * 4;
        normalData[o] = (-sx * inv * 0.5 + 0.5) * 255;
        normalData[o + 1] = (-sy * inv * 0.5 + 0.5) * 255;
        normalData[o + 2] = (inv * 0.5 + 0.5) * 255;
      }
    }
    this.normalTexture.needsUpdate = true;

    this.writeColour(tint);
    if (!this.base || this.base.userData.thickness !== baseThickness) this.setBase(baseThickness);
    this.invalidate();
  }

  private disposePlate(): void {
    if (this.top) {
      this.group.remove(this.top);
      this.top.geometry.dispose();
      this.top.material.dispose();
      this.top = null;
    }
    if (this.base) {
      this.group.remove(this.base);
      this.base.geometry.dispose();
      (this.base.material as THREE.Material).dispose();
      this.base = null;
    }
    this.heightTexture?.dispose();
    this.normalTexture?.dispose();
    this.colourTexture?.dispose();
    this.heightTexture = this.normalTexture = this.colourTexture = null;
  }
}
