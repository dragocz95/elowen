'use client';
import { AnimatePresence, type HTMLMotionProps } from 'motion/react';
import * as m from 'motion/react-m';
import { forwardRef, type ReactNode } from 'react';
import { motionTransition, revealVariants, staggerVariants } from '../../lib/motion';
import { useEffects } from '../../lib/useEffects';

type DivMotionProps = Omit<HTMLMotionProps<'div'>, 'ref' | 'initial' | 'animate' | 'exit' | 'transition' | 'variants'>;

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

/** Keeps structural UI changes spatially understandable. Lists normally use popLayout so the
 * remaining rows reflow immediately while the removed row finishes its short exit. */
export function MotionPresence({ children, mode = 'popLayout' }: {
  children: ReactNode;
  mode?: 'sync' | 'wait' | 'popLayout';
}) {
  const { motionEnabled } = useEffects();
  return <AnimatePresence initial={false} mode={motionEnabled ? mode : 'sync'}>{children}</AnimatePresence>;
}

/** Shared layout container for registers, grids and changing filter results. */
export function MotionLayout({ children, ...props }: DivMotionProps & { children: ReactNode }) {
  return <m.div {...props} layout>{children}</m.div>;
}

/** One reorderable/present item. It becomes opacity-only when effects are reduced and static when off. */
export const MotionLayoutItem = forwardRef<HTMLDivElement, DivMotionProps & {
  children: ReactNode;
  layoutId?: string;
}>(function MotionLayoutItem({ children, layoutId, ...props }, ref) {
  const { resolvedMode } = useEffects();
  return (
    <m.div
      ref={ref}
      {...props}
      layout={resolvedMode === 'full' ? 'position' : false}
      layoutId={resolvedMode === 'full' ? layoutId : undefined}
      initial={resolvedMode === 'off' ? false : { opacity: 0, y: resolvedMode === 'full' ? 6 : 0 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: resolvedMode === 'full' ? -4 : 0 }}
      transition={motionTransition}
    >
      {children}
    </m.div>
  );
});
