'use client';
import { m, type HTMLMotionProps } from 'motion/react';
import type { ReactNode } from 'react';
import { motionTransition, revealVariants, staggerVariants } from '../../lib/motion';
import { useEffects } from '../../lib/useEffects';

type DivMotionProps = Omit<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'exit' | 'transition' | 'variants'>;

interface MotionRevealProps extends DivMotionProps {
  children: ReactNode;
  delay?: number;
}

/** A small route/section entrance that automatically becomes opacity-only or static. */
export function MotionReveal({ children, delay = 0, ...props }: MotionRevealProps) {
  const { resolvedMode } = useEffects();
  const variants = resolvedMode === 'reduced'
    ? { hidden: { opacity: 0 }, visible: { opacity: 1 }, exit: { opacity: 0 } }
    : revealVariants;

  return (
    <m.div
      {...props}
      initial={resolvedMode === 'off' ? false : 'hidden'}
      animate="visible"
      exit="exit"
      variants={variants}
      transition={{ ...motionTransition, delay }}
    >
      {children}
    </m.div>
  );
}

/** Parent for a calm, short cascade of sibling MotionItems. */
export function MotionStagger({ children, ...props }: DivMotionProps & { children: ReactNode }) {
  const { resolvedMode } = useEffects();
  return (
    <m.div
      {...props}
      initial={resolvedMode === 'off' ? false : 'hidden'}
      animate="visible"
      variants={resolvedMode === 'full' ? staggerVariants : undefined}
    >
      {children}
    </m.div>
  );
}

/** Child of MotionStagger; motion is deliberately subtle and never required to understand state. */
export function MotionItem({ children, ...props }: DivMotionProps & { children: ReactNode }) {
  const { resolvedMode } = useEffects();
  return (
    <m.div
      {...props}
      variants={resolvedMode === 'full' ? revealVariants : undefined}
      transition={motionTransition}
    >
      {children}
    </m.div>
  );
}
