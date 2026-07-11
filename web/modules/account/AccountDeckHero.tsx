'use client';

import { ShieldCheck } from 'lucide-react';
import type { SpatialDeckSection } from '../../components/ui/SpatialControlDeck';
import { Avatar } from '../../components/ui/Avatar';
import type { User } from '../../lib/types';

export function AccountDeckHero({ section, user, adminLabel }: {
  section: SpatialDeckSection;
  user: User;
  adminLabel: string;
}) {
  if (section.id !== 'profile') {
    const Icon = section.icon;
    return (
      <div className="account-hero-summary">
        <span className="account-hero-summary__icon"><Icon size={28} strokeWidth={1.45} aria-hidden /></span>
        <div>
          <strong>{section.label}</strong>
          {section.description ? <p>{section.description}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="account-identity-hero">
      <Avatar user={user} size={88} />
      <div className="account-identity-hero__copy">
        <span className="account-identity-hero__name">{user.name || user.username}</span>
        {user.is_admin ? <span className="account-identity-hero__role"><ShieldCheck size={13} aria-hidden />{adminLabel}</span> : null}
      </div>
    </div>
  );
}
