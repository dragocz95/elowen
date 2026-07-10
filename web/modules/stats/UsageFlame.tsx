'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useEffects } from '../../lib/useEffects';

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uActivity;
  varying float vHeight;
  varying vec3 vNormalView;
  varying vec3 vViewDirection;

  void main() {
    vec3 p = position;
    float h = clamp((p.y + 1.15) / 2.3, 0.0, 1.0);
    float flicker = sin(uTime * 1.75 + h * 9.0) + 0.45 * sin(uTime * 3.1 - h * 15.0);
    p.x += flicker * (0.018 + h * h * 0.095) * uActivity;
    p.z += cos(uTime * 1.35 + h * 11.0) * (0.012 + h * 0.045) * uActivity;
    p.xz *= 1.0 + sin(uTime * 2.15 + h * 7.0) * 0.035 * uActivity;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    vHeight = h;
    vNormalView = normalize(normalMatrix * normal);
    vViewDirection = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uLow;
  uniform vec3 uMid;
  uniform vec3 uHigh;
  uniform float uOpacity;
  varying float vHeight;
  varying vec3 vNormalView;
  varying vec3 vViewDirection;

  void main() {
    float rim = pow(1.0 - max(dot(vNormalView, vViewDirection), 0.0), 1.45);
    vec3 lower = mix(uLow, uMid, smoothstep(0.04, 0.58, vHeight));
    vec3 color = mix(lower, uHigh, smoothstep(0.56, 0.98, vHeight));
    float ends = smoothstep(0.0, 0.08, vHeight) * (1.0 - smoothstep(0.93, 1.0, vHeight));
    float alpha = (0.22 + rim * 0.78) * ends * uOpacity;
    gl_FragColor = vec4(color * (0.72 + rim * 0.9), alpha);
  }
`;

function flameGeometry(): THREE.LatheGeometry {
  const profile: THREE.Vector2[] = [];
  for (let index = 0; index <= 28; index += 1) {
    const t = index / 28;
    const belly = Math.pow(Math.sin(Math.PI * t), 0.68);
    const taper = 1 - t * 0.58;
    const radius = 0.025 + belly * taper * 0.72;
    profile.push(new THREE.Vector2(radius, -1.12 + t * 2.28));
  }
  return new THREE.LatheGeometry(profile, 48);
}

function flameMaterial(colors: [number, number, number], opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTime: { value: 0 },
      uActivity: { value: 0.5 },
      uLow: { value: new THREE.Color(colors[0]) },
      uMid: { value: new THREE.Color(colors[1]) },
      uHigh: { value: new THREE.Color(colors[2]) },
      uOpacity: { value: opacity },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** A lightweight Three.js usage pulse. It is deliberately an abstract data flame, not a realistic
 *  generated mascot: two lathed shader shells, a few orbit lines and deterministic sparks. */
export function UsageFlame({ activity, label }: { activity: number; label: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activityRef = useRef(activity);
  const renderOnceRef = useRef<() => void>(() => undefined);
  const [ready, setReady] = useState(false);
  const { resolvedMode } = useEffects();

  useEffect(() => {
    activityRef.current = activity;
    renderOnceRef.current();
  }, [activity]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    setReady(false);
    if (resolvedMode === 'off' || !host || !canvas || (!window.WebGLRenderingContext && !window.WebGL2RenderingContext)) return;

    let renderer: THREE.WebGLRenderer | undefined;
    let frame = 0;
    let visible = true;
    let alive = true;
    const disposables: Array<{ dispose: () => void }> = [];
    const reduced = resolvedMode !== 'full';

    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(31, 1, 0.1, 20);
      camera.position.set(0, 0.08, 4.25);

      const group = new THREE.Group();
      group.rotation.z = -0.035;
      scene.add(group);

      const geometry = flameGeometry();
      const outerMaterial = flameMaterial([0x8f120d, 0xff4b2b, 0xffb154], 0.88);
      const innerMaterial = flameMaterial([0xff341f, 0xff9d45, 0xfff1b8], 0.68);
      disposables.push(geometry, outerMaterial, innerMaterial);

      const outer = new THREE.Mesh(geometry, outerMaterial);
      outer.scale.set(0.92, 1, 0.92);
      group.add(outer);

      const inner = new THREE.Mesh(geometry, innerMaterial);
      inner.scale.set(0.5, 0.72, 0.5);
      inner.position.y = -0.3;
      inner.rotation.y = Math.PI / 5;
      group.add(inner);

      const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xff5a38, transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending });
      const ringGeometry = new THREE.TorusGeometry(0.85, 0.006, 6, 80);
      disposables.push(ringMaterial, ringGeometry);
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -1.02;
      ring.scale.y = 0.62;
      group.add(ring);
      const ringTwo = ring.clone();
      ringTwo.scale.set(1.25, 0.82, 1.25);
      ringTwo.material = ringMaterial;
      group.add(ringTwo);

      const positions: number[] = [];
      for (let index = 0; index < 46; index += 1) {
        const angle = index * 2.399963;
        const radius = 0.4 + ((index * 37) % 100) / 100 * 0.75;
        positions.push(Math.cos(angle) * radius, -0.82 + ((index * 53) % 100) / 100 * 1.9, Math.sin(angle) * radius * 0.55);
      }
      const sparkGeometry = new THREE.BufferGeometry();
      sparkGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const sparkMaterial = new THREE.PointsMaterial({ color: 0xff784d, size: 0.032, transparent: true, opacity: 0.52, depthWrite: false, blending: THREE.AdditiveBlending });
      disposables.push(sparkGeometry, sparkMaterial);
      const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
      group.add(sparks);

      const resize = () => {
        if (!renderer) return;
        const rect = host.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(host);
      resize();

      let last = 0;
      const draw = (time: number) => {
        if (!renderer || !alive) return;
        const clampedActivity = Math.max(0.18, Math.min(1, activityRef.current));
        const seconds = time / 1000;
        outerMaterial.uniforms.uTime!.value = seconds;
        innerMaterial.uniforms.uTime!.value = seconds * 1.13;
        outerMaterial.uniforms.uActivity!.value = clampedActivity;
        innerMaterial.uniforms.uActivity!.value = Math.min(1, clampedActivity + 0.14);
        group.rotation.y = Math.sin(seconds * 0.16) * 0.18;
        sparks.rotation.y = seconds * 0.055;
        sparks.position.y = Math.sin(seconds * 0.72) * 0.035;
        ring.rotation.z = seconds * 0.09;
        ringTwo.rotation.z = -seconds * 0.065;
        renderer.render(scene, camera);
        last = time;
      };

      const tick = (time: number) => {
        frame = 0;
        if (!alive || !visible || document.hidden) return;
        if (time - last >= 32) draw(time);
        frame = window.requestAnimationFrame(tick);
      };
      const start = () => {
        if (!reduced && alive && visible && !document.hidden && frame === 0) frame = window.requestAnimationFrame(tick);
      };
      const stop = () => {
        if (frame !== 0) window.cancelAnimationFrame(frame);
        frame = 0;
      };

      const intersection = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true;
        if (visible) start(); else stop();
      }, { rootMargin: '100px' });
      intersection?.observe(host);
      const onVisibility = () => { if (document.hidden) stop(); else start(); };
      document.addEventListener('visibilitychange', onVisibility);
      const onContextLost = (event: Event) => { event.preventDefault(); stop(); if (alive) setReady(false); };
      canvas.addEventListener('webglcontextlost', onContextLost);

      renderOnceRef.current = () => { if (renderer && alive) draw(performance.now()); };
      draw(reduced ? 1600 : performance.now());
      if (alive) setReady(true);
      start();

      return () => {
        alive = false;
        renderOnceRef.current = () => undefined;
        stop();
        observer.disconnect();
        intersection?.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        canvas.removeEventListener('webglcontextlost', onContextLost);
        disposables.forEach((item) => item.dispose());
        renderer?.dispose();
      };
    } catch {
      setReady(false);
      disposables.forEach((item) => item.dispose());
      renderer?.dispose();
      return () => { alive = false; };
    }
  }, [resolvedMode]);

  return (
    <div ref={hostRef} role="img" aria-label={label} data-testid="usage-flame" className="relative h-full min-h-64 w-full overflow-hidden">
      <span aria-hidden className={`absolute inset-[18%] transition-opacity duration-700 ${ready ? 'opacity-0' : 'opacity-100'}`}>
        <span className="absolute inset-x-[22%] bottom-[10%] top-0 rounded-[55%_45%_62%_38%/72%_62%_38%_28%] bg-[linear-gradient(155deg,#ffd08a_0%,#ff6b38_44%,#9d160f_100%)] opacity-65 blur-[1px] [clip-path:polygon(50%_0%,73%_28%,91%_58%,76%_91%,50%_100%,22%_90%,8%_58%,31%_30%)]" />
        <span className="absolute inset-x-[34%] bottom-[13%] top-[31%] bg-[linear-gradient(#fff1c2,#ff7b3d)] opacity-80 blur-[2px] [clip-path:polygon(50%_0%,90%_60%,70%_100%,25%_96%,8%_55%)]" />
      </span>
      <canvas ref={canvasRef} aria-hidden className={`absolute inset-0 h-full w-full transition-opacity duration-700 ${ready ? 'opacity-100' : 'opacity-0'}`} />
      <span aria-hidden className="pointer-events-none absolute inset-x-[18%] bottom-[8%] h-px bg-gradient-to-r from-transparent via-accent/45 to-transparent shadow-[0_0_28px_rgb(255_82_54_/_0.45)]" />
    </div>
  );
}
