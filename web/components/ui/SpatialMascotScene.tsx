'use client';

import { Canvas, useFrame, useLoader } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdditiveBlending, Group, MathUtils, Sprite, TextureLoader } from 'three';
import type { SpatialMascotState } from './SpatialMascot.types';
import { useEffects } from '../../lib/useEffects';

function EmberScene({ state, onReady }: { state: SpatialMascotState; onReady: () => void }) {
  const mascot = useLoader(TextureLoader, '/icon.png');
  const group = useRef<Group>(null);
  const orbitOne = useRef<Group>(null);
  const orbitTwo = useRef<Group>(null);
  const particleGroup = useRef<Group>(null);
  const sprite = useRef<Sprite>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const particles = useMemo(() => Array.from({ length: 20 }, (_, index) => {
    const angle = (index / 20) * Math.PI * 2;
    const radius = 1.65 + ((index * 37) % 9) * 0.13;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.66,
      z: ((index * 19) % 7) * 0.08 - 0.24,
      scale: 0.018 + (index % 3) * 0.009,
    };
  }), []);

  useEffect(() => onReady(), [onReady]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth - 0.5) * 2;
      pointer.current.y = (event.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => window.removeEventListener('pointermove', move);
  }, []);

  useFrame(({ clock }, delta) => {
    const target = group.current;
    if (!target) return;
    const time = clock.elapsedTime;
    target.position.y = Math.sin(time * 0.72) * 0.08;
    target.rotation.x = MathUtils.damp(target.rotation.x, pointer.current.y * -0.035, 4, delta);
    target.rotation.y = MathUtils.damp(target.rotation.y, pointer.current.x * 0.055, 4, delta);
    if (sprite.current) {
      const pulse = state === 'saving' ? Math.sin(time * 5) * 0.045 : state === 'success' ? Math.max(0, Math.sin(time * 2.2)) * 0.025 : 0;
      sprite.current.scale.setScalar(2.48 + pulse);
    }
    if (orbitOne.current) orbitOne.current.rotation.z += delta * speed * 0.035;
    if (orbitTwo.current) orbitTwo.current.rotation.z -= delta * speed * 0.025;
    if (particleGroup.current) particleGroup.current.rotation.z += delta * speed * 0.12;
  });

  const ember = state === 'error' ? '#9a3028' : state === 'success' ? '#42d28f' : '#ff5236';
  const speed = state === 'saving' ? 1.9 : 0.65;

  return (
    <group ref={group}>
      <sprite ref={sprite} scale={[2.48, 2.48, 1]}>
        <spriteMaterial map={mascot} transparent depthWrite={false} />
      </sprite>
      <group ref={orbitOne}>
        <mesh rotation={[Math.PI / 2.42, 0.22, 0.18]}>
          <torusGeometry args={[2.55, 0.008, 6, 160]} />
          <meshBasicMaterial color={ember} transparent opacity={0.48} blending={AdditiveBlending} />
        </mesh>
      </group>
      <group ref={orbitTwo}>
        <mesh rotation={[Math.PI / 2.8, -0.28, -0.16]}>
          <torusGeometry args={[2.02, 0.006, 6, 140]} />
          <meshBasicMaterial color={ember} transparent opacity={0.3} blending={AdditiveBlending} />
        </mesh>
      </group>
      <group ref={particleGroup}>
        {particles.map((particle, index) => (
          <mesh key={index} position={[particle.x, particle.y, particle.z]} scale={particle.scale}>
            <sphereGeometry args={[1, 7, 7]} />
            <meshBasicMaterial color={index % 4 === 0 ? '#ffb071' : ember} transparent opacity={0.76} blending={AdditiveBlending} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** The Canvas itself owns no pointer events; visibility and document state control its render loop. */
export function SpatialMascotScene({ state, onReady }: { state: SpatialMascotState; onReady: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [intersecting, setIntersecting] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(true);
  const { motionEnabled } = useEffects();

  useEffect(() => {
    const node = host.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry?.isIntersecting ?? false), { rootMargin: '80px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  const active = intersecting && documentVisible && motionEnabled;
  return (
    <div ref={host} className="h-full w-full pointer-events-none">
      <Canvas
        className="pointer-events-none"
        dpr={[1, 1.5]}
        frameloop={active ? 'always' : 'never'}
        orthographic
        camera={{ position: [0, 0, 10], zoom: 72 }}
        gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
      >
        <EmberScene state={state} onReady={onReady} />
      </Canvas>
    </div>
  );
}
