import { forwardRef, type InputHTMLAttributes } from 'react';

import { Input as InputPrimitive } from './shadcn/input';
import { textareaVariants } from './shadcn/textarea';

/** Compatibility class for raw textareas that have not yet moved to the lowercase shadcn primitive. */
export const textareaClass = textareaVariants();

type InputProps = InputHTMLAttributes<HTMLInputElement> & { variant?: 'default' | 'line' };

/** The app-shaped input keeps its established import path and prop surface while delegating to shadcn. */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input(props, ref) {
    return <InputPrimitive ref={ref} {...props} />;
  },
);
