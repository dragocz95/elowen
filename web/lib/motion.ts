import type { Transition, Variants } from 'motion/react';

const motionEase = [0.16, 1, 0.3, 1] as const;
export const motionTransition = { duration: 0.24, ease: motionEase } satisfies Transition;

export const revealVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 4 },
} satisfies Variants;

export const staggerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } },
} satisfies Variants;
