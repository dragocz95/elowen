'use client';

import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Avatar, on Radix `@radix-ui/react-avatar`.
 *
 *  This file is the shadcn component itself — its three parts, its `data-slot` attributes and its prop
 *  surface are shadcn's. What is ours is only the styling, read from this app's tokens.
 *
 *  Behaviour is Radix's and is NOT reimplemented here: `AvatarImage` preloads the source and only paints
 *  once it has actually decoded, so a broken or slow image never flashes as a blank square, and
 *  `AvatarFallback` takes over automatically on error rather than needing an `onError` handler.
 *  `components/ui/Avatar.tsx` is the app-shaped wrapper over these parts and is what the app imports —
 *  the monogram it puts in the fallback is app policy, not Radix's job. */

function Avatar({ className = '', ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn('relative flex shrink-0 overflow-hidden rounded-full', className)}
      {...props}
    />
  );
}

function AvatarImage({ className = '', ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn('aspect-square size-full object-cover', className)}
      {...props}
    />
  );
}

function AvatarFallback({ className = '', ...props }: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn('flex size-full items-center justify-center rounded-full bg-muted', className)}
      {...props}
    />
  );
}

export { Avatar, AvatarFallback, AvatarImage };
