/**
 * Instagram Profile Resolver - Pluggable External API Provider
 *
 * Connects to external APIs (e.g. RapidAPI, custom microservices, or partner APIs)
 * configured through server-side environment variables.
 * Never exposes credentials to frontend.
 */

import type { InstagramProfileProvider } from './provider';
import type { InstagramProfileData } from '../types';
import { buildInstagramProfileUrl } from '../parser';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

export class ApiInstagramProfileProvider implements InstagramProfileProvider {
  readonly providerName = 'external_api';

  async resolve(username: string): Promise<InstagramProfileData> {
    const cleanUsername = username.trim().toLowerCase();
    const apiUrlTemplate = process.env.INSTAGRAM_PROFILE_API_URL;
    const apiKey = process.env.INSTAGRAM_PROFILE_API_KEY;
    const apiHost = process.env.INSTAGRAM_PROFILE_API_HOST;

    if (!apiUrlTemplate) {
      throw new Error('INSTAGRAM_PROFILE_API_URL is not configured in environment variables.');
    }

    // Replace {{username}} placeholder or append query param
    const targetUrl = apiUrlTemplate.includes('{{username}}')
      ? apiUrlTemplate.replace('{{username}}', encodeURIComponent(cleanUsername))
      : `${apiUrlTemplate}${apiUrlTemplate.includes('?') ? '&' : '?'}username=${encodeURIComponent(cleanUsername)}`;

    // SSRF Check on target API URL
    const isDeliverable = await isDeliverableUrl(targetUrl);
    if (!isDeliverable) {
      throw new Error('SSRF Block: External API destination is not a deliverable public URL.');
    }

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'WACRM-InstagramResolver/1.0',
    };

    if (apiKey) {
      if (apiHost) {
        // RapidAPI style headers
        headers['X-RapidAPI-Key'] = apiKey;
        headers['X-RapidAPI-Host'] = apiHost;
      } else {
        // Standard Authorization header
        headers['Authorization'] = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
      }
    }

    const res = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });

    if (!res.ok) {
      throw new Error(`External Instagram API responded with status ${res.status}`);
    }

    const data = await res.json().catch(() => ({}));

    // Flexible extraction from common response schemas
    // (e.g. { data: { profile_pic_url, full_name, ... } } or { profile_pic_url: "..." } or { user: { ... } })
    const userObj = (data.data?.user || data.data || data.user || data) as Record<string, unknown>;

    const profileImageUrl =
      (userObj.profile_pic_url_hd as string) ||
      (userObj.profile_pic_url as string) ||
      (userObj.profile_image_url as string) ||
      (userObj.avatar_url as string) ||
      null;

    const displayName =
      (userObj.full_name as string) ||
      (userObj.displayName as string) ||
      (userObj.name as string) ||
      null;

    const biography = (userObj.biography as string) || null;
    const isPrivate = typeof userObj.is_private === 'boolean' ? userObj.is_private : null;
    const isVerified = typeof userObj.is_verified === 'boolean' ? userObj.is_verified : null;
    const followersCount = typeof userObj.follower_count === 'number'
      ? userObj.follower_count
      : typeof userObj.edge_followed_by === 'object' && userObj.edge_followed_by !== null
      ? ((userObj.edge_followed_by as Record<string, unknown>).count as number)
      : null;

    return {
      username: cleanUsername,
      profileUrl: buildInstagramProfileUrl(cleanUsername),
      profileImageUrl,
      displayName,
      biography,
      isPrivate,
      isVerified,
      followersCount,
      source: 'INSTAGRAM_PROVIDER',
      fetchedAt: new Date().toISOString(),
    };
  }
}
