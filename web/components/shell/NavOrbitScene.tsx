'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const VERTEX = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 p = position;
    p += normal * sin(uTime * 0.65 + position.y * 5.0 + position.x * 3.0) * 0.018;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.1);
    vec3 hot = vec3(1.0, 0.21, 0.09);
    gl_FragColor = vec4(hot * (0.35 + rim * 1.4), 0.08 + rim * 0.5);
  }
`;

/** GPU-only ambient orbit behind the real DOM navigation. Navigation never depends on WebGL. */
export function NavOrbitScene({ side, compact = false }: { side: 'left' | 'right'; compact?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas || (!window.WebGLRenderingContext && !window.WebGL2RenderingContext)) return;

    let renderer: THREE.WebGLRenderer | undefined;
    let frame = 0;
    let alive = true;
    let visible = true;
    const disposables: Array<{ dispose: () => void }> = [];
    const fullMotion = document.documentElement.getAttribute('data-effects') === 'full';

    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.4));

      const scene = new THREE.Scene();
      // A narrow navigation viewport makes a perspective camera crop a circular scene heavily.
      // An orthographic projection keeps the complete ornament visible at every shell width.
      const camera = new THREE.OrthographicCamera(-2.6, 2.6, 2.6, -2.6, 0.1, 20);
      camera.position.set(side === 'left' ? 0.35 : -0.35, 0, 5.6);

      const group = new THREE.Group();
      group.rotation.set(1.08, side === 'left' ? -0.28 : 0.28, 0.08);
      group.scale.y = compact ? 2.15 : 1.18;
      scene.add(group);

      const ringGeometry = new THREE.TorusGeometry(1.43, 0.028, 12, 128);
      const ringMaterial = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: { uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      disposables.push(ringGeometry, ringMaterial);
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      group.add(ring);

      const lineMaterial = new THREE.MeshBasicMaterial({ color: 0xff4c2e, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending });
      const lineGeometry = new THREE.TorusGeometry(1.72, 0.007, 6, 128);
      disposables.push(lineMaterial, lineGeometry);
      const outer = new THREE.Mesh(lineGeometry, lineMaterial);
      outer.rotation.set(0.34, 0.12, -0.2);
      group.add(outer);
      const inner = outer.clone();
      inner.scale.setScalar(0.72);
      inner.rotation.set(-0.42, 0.28, 0.35);
      group.add(inner);

      const positions: number[] = [];
      for (let index = 0; index < 92; index += 1) {
        const angle = index * 2.399963;
        const radius = 0.9 + ((index * 37) % 100) / 100 * 1.15;
        positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.88, (((index * 53) % 100) / 100 - 0.5) * 0.9);
      }
      const pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const pointMaterial = new THREE.PointsMaterial({ color: 0xff6b48, size: 0.027, transparent: true, opacity: 0.46, depthWrite: false, blending: THREE.AdditiveBlending });
      disposables.push(pointGeometry, pointMaterial);
      const points = new THREE.Points(pointGeometry, pointMaterial);
      group.add(points);

      const resize = () => {
        if (!renderer) return;
        const rect = host.getBoundingClientRect();
        renderer.setSize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), false);
        const aspect = Math.max(1, rect.width) / Math.max(1, rect.height);
        const horizontalHalf = 2.6;
        const verticalHalf = horizontalHalf / Math.max(0.18, aspect);
        camera.left = -horizontalHalf;
        camera.right = horizontalHalf;
        camera.top = verticalHalf;
        camera.bottom = -verticalHalf;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();

      const draw = (time: number) => {
        if (!renderer || !alive) return;
        const seconds = time / 1000;
        ringMaterial.uniforms.uTime!.value = seconds;
        group.rotation.z = 0.08 + Math.sin(seconds * 0.17) * 0.08;
        ring.rotation.z = seconds * 0.08;
        outer.rotation.z = -seconds * 0.045;
        inner.rotation.z = seconds * 0.06;
        points.rotation.z = seconds * 0.025;
        renderer.render(scene, camera);
      };

      const tick = (time: number) => {
        frame = 0;
        if (!alive || !visible || document.hidden) return;
        draw(time);
        frame = window.requestAnimationFrame(tick);
      };
      const start = () => { if (fullMotion && alive && visible && !document.hidden && frame === 0) frame = window.requestAnimationFrame(tick); };
      const stop = () => { if (frame) window.cancelAnimationFrame(frame); frame = 0; };
      const intersection = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true;
        if (visible) start(); else stop();
      });
      intersection?.observe(host);
      const onVisibility = () => { if (document.hidden) stop(); else start(); };
      document.addEventListener('visibilitychange', onVisibility);
      draw(1200);
      start();

      return () => {
        alive = false;
        stop();
        observer.disconnect();
        intersection?.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        disposables.forEach((item) => item.dispose());
        renderer?.dispose();
      };
    } catch {
      alive = false;
      disposables.forEach((item) => item.dispose());
      renderer?.dispose();
    }
  }, [compact, side]);

  return (
    <div ref={hostRef} data-testid="orbit-webgl" aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <span className={`absolute top-1/2 -translate-y-1/2 rounded-full border border-accent/15 shadow-[0_0_60px_rgb(255_82_54_/_0.08)] ${compact ? 'inset-x-3 h-52' : 'inset-x-8 h-80'}`} />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full opacity-90" />
    </div>
  );
}
