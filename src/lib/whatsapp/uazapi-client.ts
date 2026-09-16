/**
 * UazAPI Client (uazapiGO)
 *
 * Multi-provider WhatsApp integration for unofficial Baileys/Go-based WhatsApp instances.
 * Handles instance connection, QR code generation, message sending, and webhook setup.
 */

export interface UazApiStatusResponse {
  status: 'connected' | 'connecting' | 'disconnected' | 'hibernated' | 'unknown';
  qrcode?: string | null;
  pairingCode?: string | null;
  phone?: string | null;
  name?: string | null;
  raw?: Record<string, unknown>;
}

export interface UazApiConnectResponse {
  status: string;
  qrcode?: string | null;
  pairingCode?: string | null;
  phone?: string | null;
  message?: string;
  raw?: Record<string, unknown>;
}

export interface UazApiSendResult {
  messageId: string;
  status: string;
  raw?: Record<string, unknown>;
}

/**
 * Normalise base URL (strip trailing slashes).
 */
export function normalizeBaseUrl(url?: string | null): string {
  if (!url || !url.trim()) return 'https://free.uazapi.com';
  return url.trim().replace(/\/+$/, '');
}

/**
 * Format phone number for UazAPI (numeric string only without '+' or spaces).
 */
export function formatUazApiNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    return `55${digits}`;
  }
  return digits;
}

/**
 * Fetch instance status from UazAPI.
 */
export async function getUazApiStatus(
  baseUrl: string,
  token: string
): Promise<UazApiStatusResponse> {
  const url = `${normalizeBaseUrl(baseUrl)}/instance/status`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        token,
        'Content-Type': 'application/json',
      },
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        status: 'disconnected',
        raw: data,
      };
    }

    // Uazapi returns status in data.instance.status, data.status (string or object), or data.connected
    let statusVal = 'unknown';
    if (typeof data.status === 'string') {
      statusVal = data.status.toLowerCase();
    } else if (typeof data.instance?.status === 'string') {
      statusVal = data.instance.status.toLowerCase();
    } else if (typeof data.data?.status === 'string') {
      statusVal = data.data.status.toLowerCase();
    } else if (data.status && typeof data.status === 'object') {
      if (data.status.connected || data.status.loggedIn) {
        statusVal = 'connected';
      } else if (data.status.connecting) {
        statusVal = 'connecting';
      } else {
        statusVal = 'disconnected';
      }
    } else if (data.connected === true) {
      statusVal = 'connected';
    }

    const rawQr = data.qrcode || data.instance?.qrcode || data.data?.qrcode || null;
    const qrcode = rawQr && typeof rawQr === 'string' && rawQr.trim().length > 0 ? rawQr.trim() : null;

    const rawPair = data.pairingCode || data.instance?.pairingCode || null;
    const pairingCode = rawPair && typeof rawPair === 'string' && rawPair.trim().length > 0 ? rawPair.trim() : null;

    // Extract phone number from owner, jid, or phone fields
    let phone: string | null = null;
    if (data.instance?.owner) {
      phone = formatUazApiNumber(String(data.instance.owner));
    } else if (data.status?.jid) {
      phone = formatUazApiNumber(String(data.status.jid).split('@')[0].split(':')[0]);
    } else if (data.phone) {
      phone = formatUazApiNumber(String(data.phone));
    } else if (data.instance?.phone) {
      phone = formatUazApiNumber(String(data.instance.phone));
    } else if (data.number) {
      phone = formatUazApiNumber(String(data.number));
    }

    const name = data.instance?.profileName || data.instance?.name || data.name || null;

    let normalizedStatus: UazApiStatusResponse['status'] = 'unknown';
    if (statusVal === 'connected' || statusVal === 'open' || statusVal === 'authenticated') {
      normalizedStatus = 'connected';
    } else if (statusVal === 'connecting' || statusVal === 'qrcode' || statusVal === 'scan') {
      normalizedStatus = 'connecting';
    } else if (statusVal === 'disconnected' || statusVal === 'close' || statusVal === 'closed') {
      normalizedStatus = 'disconnected';
    } else if (statusVal === 'hibernated') {
      normalizedStatus = 'hibernated';
    }

    return {
      status: normalizedStatus,
      qrcode,
      pairingCode,
      phone,
      name,
      raw: data,
    };
  } catch (err) {
    return {
      status: 'disconnected',
      raw: { error: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Connect instance to WhatsApp (returns QR Code or pairing code).
 */
export async function connectUazApi(
  baseUrl: string,
  token: string,
  phone?: string
): Promise<UazApiConnectResponse> {
  const url = `${normalizeBaseUrl(baseUrl)}/instance/connect`;

  const body: Record<string, string> = {};
  if (phone) {
    body.phone = formatUazApiNumber(phone);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Failed to connect instance (HTTP ${res.status})`
    );
  }

  const isConnected =
    data.connected === true ||
    data.loggedIn === true ||
    data.response === 'Already connected' ||
    Boolean(data.status?.connected) ||
    Boolean(data.status?.loggedIn) ||
    data.instance?.status === 'connected';

  let normalizedStatus = isConnected ? 'connected' : 'connecting';
  if (!isConnected) {
    const rawStatus =
      typeof data.status === 'string'
        ? data.status.toLowerCase()
        : typeof data.instance?.status === 'string'
          ? data.instance.status.toLowerCase()
          : '';
    if (rawStatus === 'disconnected' || rawStatus === 'close' || rawStatus === 'closed') {
      normalizedStatus = 'disconnected';
    } else if (rawStatus === 'connected' || rawStatus === 'open') {
      normalizedStatus = 'connected';
    }
  }

  // Extract QR Code safely
  let qrcode: string | null = null;
  const rawQr = data.qrcode ?? data.instance?.qrcode ?? data.data?.qrcode ?? data.base64 ?? null;
  if (typeof rawQr === 'string' && rawQr.trim().length > 0) {
    qrcode = rawQr.trim();
  } else if (
    rawQr &&
    typeof rawQr === 'object' &&
    'base64' in (rawQr as Record<string, unknown>) &&
    typeof (rawQr as { base64: unknown }).base64 === 'string'
  ) {
    qrcode = (rawQr as { base64: string }).base64.trim();
  }

  // Extract Pairing Code safely
  let pairingCode: string | null = null;
  const rawPair =
    data.pairingCode ??
    data.paircode ??
    data.instance?.pairingCode ??
    data.instance?.paircode ??
    null;
  if (typeof rawPair === 'string' && rawPair.trim().length > 0) {
    pairingCode = rawPair.trim();
  }

  // Extract phone number
  let extractedPhone: string | null = null;
  if (data.instance?.owner) {
    extractedPhone = formatUazApiNumber(String(data.instance.owner));
  } else if (data.status?.jid) {
    extractedPhone = formatUazApiNumber(String(data.status.jid).split('@')[0].split(':')[0]);
  } else if (data.jid) {
    extractedPhone = formatUazApiNumber(String(data.jid).split('@')[0].split(':')[0]);
  } else if (data.phone) {
    extractedPhone = formatUazApiNumber(String(data.phone));
  }

  return {
    status: normalizedStatus,
    qrcode,
    pairingCode,
    phone: extractedPhone,
    message: typeof data.response === 'string' ? data.response : data.message,
    raw: data,
  };
}

/**
 * Disconnect an active WhatsApp session on UazAPI.
 */
export async function disconnectUazApi(
  baseUrl: string,
  token: string
): Promise<boolean> {
  const url = `${normalizeBaseUrl(baseUrl)}/instance/disconnect`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      token,
      'Content-Type': 'application/json',
    },
  });

  return res.ok;
}

/**
 * Send text message via UazAPI.
 */
export async function sendUazApiText(
  baseUrl: string,
  token: string,
  opts: {
    number: string;
    text: string;
    replyId?: string;
  }
): Promise<UazApiSendResult> {
  const url = `${normalizeBaseUrl(baseUrl)}/send/text`;

  const formattedNumber = formatUazApiNumber(opts.number);

  const body: Record<string, unknown> = {
    number: formattedNumber,
    text: opts.text,
  };

  if (opts.replyId) {
    body.replyid = opts.replyId;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Failed to send text message (HTTP ${res.status})`
    );
  }

  const messageId =
    data.id ||
    data.messageId ||
    data.key?.id ||
    data.data?.key?.id ||
    `uazapi_${Date.now()}`;

  return {
    messageId,
    status: 'sent',
    raw: data,
  };
}

/**
 * Send media message via UazAPI.
 *
 * UazAPI uses the `/send/media` endpoint and requires the `file` field
 * containing the media URL. For voice notes/audios, passing `type: 'audio'`,
 * `ptt: true`, `voice: true` delivers the audio as a native WhatsApp PTT voice message.
 */
export async function sendUazApiMedia(
  baseUrl: string,
  token: string,
  opts: {
    number: string;
    url: string;
    type: 'image' | 'video' | 'audio' | 'document' | 'ptt';
    caption?: string;
    ptt?: boolean;
  }
): Promise<UazApiSendResult> {
  if (!opts.url || typeof opts.url !== 'string' || !opts.url.trim()) {
    throw new Error('Mídia sem URL válida para envio.');
  }

  const normalized = normalizeBaseUrl(baseUrl);
  const formattedNumber = formatUazApiNumber(opts.number);
  const endpoint = `${normalized}/send/media`;

  const mediaUrl = opts.url.trim();

  // UazAPI media endpoints accept 'file', 'url', 'media', 'mediaUrl'.
  // Providing all primary & alias keys ensures 100% compatibility across
  // UazAPI server builds and prevents any "missing file field" errors.
  const body: Record<string, unknown> = {
    number: formattedNumber,
    file: mediaUrl,
    url: mediaUrl,
    media: mediaUrl,
    mediaUrl: mediaUrl,
    type: opts.type,
  };

  if (opts.type === 'audio' || opts.type === 'ptt' || opts.ptt) {
    body.type = 'ptt';
    body.ptt = true;
    body.voice = true;
    body.isAudio = true;
    body.isVoice = true;
    body.isPtt = true;
    body.isForwarded = false;
    body.forwarded = false;
    // CRITICAL: Voice notes (PTT) MUST NOT carry a text caption on WhatsApp!
    // Carrying a caption forces WhatsApp to convert the voice note into a
    // forwarded audio file attachment instead of a native voice note with avatar & waveform.
    delete body.caption;
  } else if (opts.caption) {
    body.caption = opts.caption;
  }

  console.log(`[sendUazApiMedia] Sending ${opts.type} to ${formattedNumber} via ${endpoint}`);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000), // 35s for transcoding/large files
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error(`[sendUazApiMedia] Failed (HTTP ${res.status}):`, JSON.stringify(data));
    throw new Error(
      data.message || data.error || `Failed to send media (HTTP ${res.status})`
    );
  }

  const messageId =
    data.messageid ||
    data.id ||
    data.messageId ||
    data.content?.id ||
    data.key?.id ||
    data.data?.key?.id ||
    `uazapi_media_${Date.now()}`;

  console.log(`[sendUazApiMedia] Success! messageId: ${messageId}`);

  return {
    messageId,
    status: 'sent',
    raw: data,
  };
}

/**
 * Configure webhook in UazAPI.
 */
export async function setUazApiWebhook(
  baseUrl: string,
  token: string,
  webhookUrl: string
): Promise<{ success: boolean; raw?: Record<string, unknown> }> {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/webhook`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url: webhookUrl,
      enabled: true,
      events: ['messages', 'messages_update', 'connection'],
    }),
    signal: AbortSignal.timeout(5000),
  });

  const data = await res.json().catch(() => ({}));

  return {
    success: res.ok,
    raw: data,
  };
}

/**
 * Send presence update via UazAPI (composing, recording, paused).
 */
export async function sendUazApiPresence(
  baseUrl: string,
  token: string,
  opts: {
    number: string;
    presence: 'composing' | 'recording' | 'paused';
    delay?: number;
  }
): Promise<boolean> {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/message/presence`;
  const formattedNumber = formatUazApiNumber(opts.number);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: formattedNumber,
        presence: opts.presence,
        delay: opts.delay ?? 5000,
      }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch (err) {
    console.warn('[uazapi-client] sendPresence error:', err);
    return false;
  }
}

/**
 * Mark messages as read via UazAPI.
 */
export async function markUazApiMessageRead(
  baseUrl: string,
  token: string,
  messageIds: string[]
): Promise<boolean> {
  if (!messageIds || messageIds.length === 0) return false;
  const endpoint = `${normalizeBaseUrl(baseUrl)}/message/markread`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: messageIds,
      }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[uazapi-client] markMessageRead error:', err);
    return false;
  }
}

/**
 * Add or save contact in phone's WhatsApp address book via UazAPI.
 * Essential for WhatsApp Status / Stories visibility.
 * Endpoint: POST /contact/add
 */
export async function addUazApiContact(
  baseUrl: string,
  token: string,
  opts: {
    number: string;
    name: string;
  }
): Promise<{ success: boolean; message?: string; error?: string }> {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/contact/add`;
  const formattedNumber = formatUazApiNumber(opts.number);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        number: formattedNumber,
        name: opts.name.trim(),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return {
        success: false,
        error: data.message || data.error || `HTTP ${res.status}`,
      };
    }

    return {
      success: true,
      message: data.message || 'Contato adicionado à agenda com sucesso',
    };
  } catch (err: any) {
    console.warn('[uazapi-client] addUazApiContact error:', err);
    return {
      success: false,
      error: err?.message || 'Falha na conexão com UazAPI',
    };
  }
}


