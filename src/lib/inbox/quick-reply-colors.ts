/**
 * Quick reply badge / type default colors.
 */
export function getDefaultColorForKind(kind: string): string {
  switch (kind) {
    case 'audio':
      return '#A855F7'; // Purple
    case 'sequence':
      return '#F97316'; // Orange
    case 'image':
      return '#3B82F6'; // Blue
    case 'video':
      return '#06B6D4'; // Cyan
    case 'document':
      return '#EF4444'; // Red
    case 'interactive':
      return '#10B981'; // Emerald
    case 'text':
    default:
      return '#EAB308'; // Amber / Gold
  }
}
