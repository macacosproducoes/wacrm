/**
 * Instagram Profile Resolver - Types
 *
 * Types for parsing, normalizing, resolving, caching, and storing
 * Instagram profiles and profile pictures for CRM contacts & Creative Engine.
 */

export type ProfileImageSource = 'MANUAL' | 'STORED' | 'INSTAGRAM_PROVIDER';

export type InstagramResolveStatus =
  | 'NOT_REQUESTED'
  | 'PENDING'
  | 'RESOLVING'
  | 'RESOLVED'
  | 'IMAGE_AVAILABLE'
  | 'IMAGE_UNAVAILABLE'
  | 'FAILED'
  | 'MANUAL_REQUIRED';

export interface InstagramIdentifierResult {
  detected: boolean;
  username?: string | null;
  profileUrl?: string | null;
  multipleDetected?: boolean;
  allUsernames?: string[];
  candidates?: string[];
}

export interface InstagramProfileData {
  username: string;
  profileUrl: string;
  profileImageUrl?: string | null;
  displayName?: string | null;
  biography?: string | null;
  followersCount?: number | null;
  isPrivate?: boolean | null;
  isVerified?: boolean | null;
  source: ProfileImageSource;
  fetchedAt: string;
}

export interface ResolveProfileOptions {
  forceRefresh?: boolean;
  providerName?: string;
  ttlHours?: number;
}

export interface ResolvedContactInstagram {
  contactId: string;
  instagramUsername: string;
  instagramUrl: string;
  profileImageUrl?: string | null;
  profileImageSource: ProfileImageSource;
  resolveStatus: InstagramResolveStatus;
  diagnosticState?: InstagramDiagnosticState;
  hash?: string | null;
  updatedAt: string;
  error?: string | null;
}

export type InstagramDiagnosticState =
  | 'NOT_RESOLVED'
  | 'RESOLVING'
  | 'IMAGE_AVAILABLE'
  | 'IMAGE_DOWNLOAD_FAILED'
  | 'IMAGE_INVALID'
  | 'INSTAGRAM_HTTP_429'
  | 'INSTAGRAM_BLOCKED'
  | 'INSTAGRAM_PROFILE_NOT_FOUND'
  | 'STORAGE_UPLOAD_FAILED'
  | 'IMAGE_URL_UNREACHABLE'
  | 'UNKNOWN_ERROR';

export interface InstagramDiagnosticInfo {
  state: InstagramDiagnosticState;
  badgeLabel: string;
  badgeVariant: 'default' | 'secondary' | 'destructive' | 'outline' | 'success';
  title: string;
  description: string;
  technicalError?: string | null;
  canRetry: boolean;
}

/**
 * Translates low-level status and error messages into explicit diagnostic states
 * with helpful, actionable Portuguese descriptions for the CRM user.
 */
export function getInstagramDiagnosticInfo(contact: {
  instagram_username?: string | null;
  instagram_resolve_status?: string | null;
  instagram_last_error?: string | null;
  profile_image_url?: string | null;
  profile_image_source?: string | null;
}): InstagramDiagnosticInfo {
  const username = contact?.instagram_username?.trim();
  const status = contact?.instagram_resolve_status || 'NOT_REQUESTED';
  const error = (contact?.instagram_last_error || '').trim();
  const hasImage = Boolean(contact?.profile_image_url?.trim());

  if (!username) {
    return {
      state: 'NOT_RESOLVED',
      badgeLabel: 'Não informado',
      badgeVariant: 'outline',
      title: 'Instagram não informado',
      description: 'Nenhum @ de Instagram associado a este contato.',
      canRetry: false,
    };
  }

  if (status === 'RESOLVING') {
    return {
      state: 'RESOLVING',
      badgeLabel: 'Consultando...',
      badgeVariant: 'secondary',
      title: 'Consultando Instagram',
      description: 'Buscando foto pública de perfil no Instagram...',
      canRetry: false,
    };
  }

  if (hasImage && (status === 'IMAGE_AVAILABLE' || status === 'RESOLVED' || contact?.profile_image_source === 'MANUAL')) {
    return {
      state: 'IMAGE_AVAILABLE',
      badgeLabel: 'Disponível',
      badgeVariant: 'success',
      title: 'Foto Disponível',
      description: 'Foto do perfil do Instagram obtida e pronta para uso no Creative Engine.',
      canRetry: true,
    };
  }

  // Evaluate technical errors
  const errUpper = error.toUpperCase();

  if (errUpper.includes('429') || errUpper.includes('RATE_LIMIT') || errUpper.includes('TOO MANY REQUESTS')) {
    return {
      state: 'INSTAGRAM_HTTP_429',
      badgeLabel: 'HTTP 429',
      badgeVariant: 'destructive',
      title: 'Limite de Consultas Atingido',
      description: 'O Instagram bloqueou temporariamente as consultas. Aguarde alguns minutos e tente novamente.',
      technicalError: error || 'Instagram HTTP 429 - Rate limit exceeded',
      canRetry: true,
    };
  }

  if (errUpper.includes('404') || errUpper.includes('NOT_FOUND') || errUpper.includes('NOT FOUND') || errUpper.includes('PROFILE_NOT_FOUND')) {
    return {
      state: 'INSTAGRAM_PROFILE_NOT_FOUND',
      badgeLabel: 'Não encontrado',
      badgeVariant: 'destructive',
      title: 'Perfil Não Encontrado',
      description: 'O perfil @' + username + ' não existe ou foi alterado/desativado no Instagram.',
      technicalError: error || 'Instagram HTTP 404 - Profile not found',
      canRetry: true,
    };
  }

  if (errUpper.includes('BLOCK') || errUpper.includes('CHALLENGE') || errUpper.includes('LOGIN_REQUIRED') || errUpper.includes('RESTRICTED')) {
    return {
      state: 'INSTAGRAM_BLOCKED',
      badgeLabel: 'Bloqueado',
      badgeVariant: 'destructive',
      title: 'Acesso Restrito pelo Instagram',
      description: 'O Instagram exigiu verificação de segurança para visualizar este perfil público.',
      technicalError: error || 'Instagram access restricted/blocked',
      canRetry: true,
    };
  }

  if (errUpper.includes('STORAGE') || errUpper.includes('UPLOAD_FAILED') || errUpper.includes('BUCKET')) {
    return {
      state: 'STORAGE_UPLOAD_FAILED',
      badgeLabel: 'Erro de Storage',
      badgeVariant: 'destructive',
      title: 'Falha no Armazenamento',
      description: 'A imagem foi encontrada, mas não conseguiu ser armazenada no Supabase Storage.',
      technicalError: error,
      canRetry: true,
    };
  }

  if (errUpper.includes('INVALID') || errUpper.includes('CORRUPT') || errUpper.includes('NOT AN IMAGE')) {
    return {
      state: 'IMAGE_INVALID',
      badgeLabel: 'Imagem inválida',
      badgeVariant: 'destructive',
      title: 'Arquivo de Imagem Inválido',
      description: 'O Instagram respondeu, mas o arquivo retornado não é uma imagem válida.',
      technicalError: error,
      canRetry: true,
    };
  }

  if (errUpper.includes('TIMEOUT') || errUpper.includes('ABORT') || errUpper.includes('ECONNREFUSED') || errUpper.includes('UNREACHABLE')) {
    return {
      state: 'IMAGE_URL_UNREACHABLE',
      badgeLabel: 'Timeout',
      badgeVariant: 'destructive',
      title: 'Tempo Limite Excedido',
      description: 'A consulta ao Instagram excedeu o tempo limite. Verifique a conexão do servidor.',
      technicalError: error,
      canRetry: true,
    };
  }

  if (status === 'IMAGE_UNAVAILABLE' || errUpper.includes('DOWNLOAD_FAILED')) {
    return {
      state: 'IMAGE_DOWNLOAD_FAILED',
      badgeLabel: 'Sem foto',
      badgeVariant: 'destructive',
      title: 'Foto Indisponível',
      description: 'O perfil foi identificado, mas não possui foto pública de perfil disponível ou o download falhou.',
      technicalError: error || 'Profile image unavailable',
      canRetry: true,
    };
  }

  if (status === 'FAILED' || error) {
    return {
      state: 'UNKNOWN_ERROR',
      badgeLabel: 'Erro',
      badgeVariant: 'destructive',
      title: 'Falha na Resolução',
      description: error || 'Não foi possível carregar o perfil do Instagram no momento.',
      technicalError: error,
      canRetry: true,
    };
  }

  return {
    state: 'NOT_RESOLVED',
    badgeLabel: 'Pendente',
    badgeVariant: 'secondary',
    title: 'Aguardando Consulta',
    description: 'Perfil @' + username + ' ainda não foi consultado.',
    canRetry: true,
  };
}

