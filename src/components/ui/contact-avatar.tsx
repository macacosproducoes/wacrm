'use client';

import { useState } from 'react';
import { User } from 'lucide-react';
import { getContactAvatarUrl } from '@/lib/contacts/avatar';
import { cn } from '@/lib/utils';

interface ContactAvatarProps {
  name?: string | null;
  phone?: string | null;
  avatarUrl?: string | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}

const sizeClasses = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
  xl: 'h-16 w-16 text-xl',
};

const PALETTES = [
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/20',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/20',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/20',
  'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/20',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/20',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/20',
];

function getPaletteClass(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % PALETTES.length;
  return PALETTES[idx];
}

export function ContactAvatar({
  name,
  phone,
  avatarUrl,
  size = 'md',
  className,
}: ContactAvatarProps) {
  const [imgError, setImgError] = useState(false);

  const realPhotoSrc = getContactAvatarUrl({ name, phone, avatar_url: avatarUrl });
  const rawDisplayName = (name || phone || '').trim();

  // Check if contact has an actual alphabetical name vs just a phone number
  const hasAlphabeticName = /[a-zA-ZÀ-ÿ]/.test(rawDisplayName);

  let initials = '';
  if (hasAlphabeticName) {
    const parts = rawDisplayName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      initials = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    } else {
      initials = rawDisplayName.slice(0, 2).toUpperCase();
    }
  }

  const paletteClass = getPaletteClass(rawDisplayName || 'contact');

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border select-none transition-transform',
        sizeClasses[size],
        realPhotoSrc && !imgError ? 'bg-muted border-border/40' : paletteClass,
        className
      )}
    >
      {realPhotoSrc && !imgError ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={realPhotoSrc}
          alt={rawDisplayName}
          onError={() => setImgError(true)}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : hasAlphabeticName && initials ? (
        <span className="font-semibold tracking-tight">{initials}</span>
      ) : (
        <User className="h-1/2 w-1/2 opacity-75" />
      )}
    </div>
  );
}

