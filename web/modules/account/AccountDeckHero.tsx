'use client';

import { ShieldCheck } from 'lucide-react';
import type { SpatialDeckSection } from '../../components/ui/SpatialControlDeck';
import { Avatar } from '../../components/ui/Avatar';
import type { User } from '../../lib/types';
import { SectionHeroSummary } from '../../components/ui/SectionHeroSummary';

export function AccountDeckHero({ section, user, adminLabel }: {
  section: SpatialDeckSection;
  user: User;
  adminLabel: string;
}) {
  if (section.id !== 'profile') {
    return <SectionHeroSummary icon={section.icon} title={section.label} description={section.description} />;
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
