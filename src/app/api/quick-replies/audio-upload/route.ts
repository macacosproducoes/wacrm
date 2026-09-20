import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";
import { inspectAudioBytes, cleanAudioTitle } from "@/lib/audio/audio-file-normalizer";
import { decrypt } from "@/lib/whatsapp/encryption";
import { normalizeBaseUrl } from "@/lib/whatsapp/uazapi-client";

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!profile?.account_id) {
      return NextResponse.json({ error: "Conta não identificada." }, { status: 400 });
    }

    const accountId = profile.account_id as string;
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const rawTitle = formData.get("title") as string | null;
    const rawShortcut = formData.get("shortcut") as string | null;
    const rawCategory = formData.get("category") as string | null;

    if (!file) {
      return NextResponse.json({ error: "Nenhum arquivo enviado." }, { status: 400 });
    }

    let fileBuffer = Buffer.from(await file.arrayBuffer());
    let detectedMime = file.type || "audio/ogg";
    let extension = "ogg";
    let durationSeconds: number | undefined;

    // 1. Inspect audio binary bytes
    const inspected = inspectAudioBytes(new Uint8Array(fileBuffer));
    if (inspected.mime) {
      detectedMime = inspected.mime;
      extension = inspected.extension;
    }
    if (inspected.duration && inspected.duration > 0) {
      durationSeconds = inspected.duration;
    }

    const admin = getAdminClient();

    // 2. If it is an encrypted WhatsApp .enc file (or lacks standard audio container markers)
    const isEnc =
      file.name.toLowerCase().endsWith(".enc") ||
      (fileBuffer.length > 0 &&
        !inspected.duration &&
        !fileBuffer.subarray(0, 4).toString("ascii").startsWith("OggS") &&
        !fileBuffer.subarray(0, 3).toString("ascii").startsWith("ID3"));

    if (isEnc) {
      // Try resolving matching message in DB by filename pattern (e.g. 814853687)
      const numMatch = file.name.match(/\d{6,}/);
      const pattern = numMatch ? numMatch[0] : null;

      let matchedMsg = null;
      if (pattern) {
        const { data: msg } = await admin
          .from("messages")
          .select("id, conversation_id, message_id, media_url, content_type")
          .ilike("media_url", `%${pattern}%`)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        matchedMsg = msg;
      }

      // If no filename match, check most recent audio messages in this account
      if (!matchedMsg) {
        const { data: recentMsgs } = await admin
          .from("messages")
          .select("id, conversation_id, message_id, media_url, content_type")
          .eq("content_type", "audio")
          .order("created_at", { ascending: false })
          .limit(5);

        if (recentMsgs && recentMsgs.length > 0) {
          // See if any has matching file size or decrypted URL
          matchedMsg = recentMsgs[0];
        }
      }

      if (matchedMsg) {
        let decryptedUrl = matchedMsg.media_url;

        // If media_url is still raw encrypted WhatsApp mmg.whatsapp.net, call UazAPI download
        if (
          !decryptedUrl ||
          decryptedUrl.includes("mmg.whatsapp.net") ||
          decryptedUrl.includes(".enc")
        ) {
          // Find active WhatsApp connection
          const { data: connections } = await admin
            .from("whatsapp_connections")
            .select("*")
            .eq("account_id", accountId)
            .eq("provider", "uazapi");

          const activeConn =
            connections?.find((c) => c.status === "connected") || connections?.[0];

          if (activeConn) {
            const tokenEnc =
              activeConn.provider_config?.token || activeConn.encrypted_access_token;
            if (tokenEnc) {
              try {
                const token = decrypt(tokenEnc);
                const baseUrl = normalizeBaseUrl(
                  activeConn.provider_config?.base_url || activeConn.api_url
                );
                const targetMsgId = matchedMsg.message_id || matchedMsg.id;

                const dlRes = await fetch(`${baseUrl}/message/download`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    token,
                  },
                  body: JSON.stringify({
                    id: targetMsgId,
                    return_link: true,
                    return_base64: false,
                  }),
                  signal: AbortSignal.timeout(6000),
                });

                if (dlRes.ok) {
                  const dlData = await dlRes.json().catch(() => null);
                  if (dlData?.fileURL) {
                    decryptedUrl = String(dlData.fileURL);
                    await admin
                      .from("messages")
                      .update({ media_url: decryptedUrl })
                      .eq("id", matchedMsg.id);
                  }
                }
              } catch (uazErr) {
                console.warn("[audio-upload] UazAPI download error:", uazErr);
              }
            }
          }
        }

        // If we have a decrypted public URL, download clean audio bytes
        if (
          decryptedUrl &&
          !decryptedUrl.includes("mmg.whatsapp.net") &&
          !decryptedUrl.includes(".enc")
        ) {
          try {
            const audioFetch = await fetch(decryptedUrl);
            if (audioFetch.ok) {
              fileBuffer = Buffer.from(await audioFetch.arrayBuffer());
              const freshInspect = inspectAudioBytes(new Uint8Array(fileBuffer));
              detectedMime = freshInspect.mime || "audio/mpeg";
              extension = freshInspect.extension || "mp3";
              if (freshInspect.duration) durationSeconds = freshInspect.duration;
            }
          } catch (fetchErr) {
            console.warn("[audio-upload] Error fetching decrypted audio:", fetchErr);
          }
        }
      }
    }

    // 3. Guarantee positive duration
    if (!durationSeconds || durationSeconds <= 0) {
      // Estimate from file size: ~3.2 KB / sec in Opus
      const estimated = Math.round(fileBuffer.length / 3200);
      durationSeconds = Math.min(300, Math.max(3, estimated || 5));
    }

    // 4. Build clean storage path
    const title = (rawTitle?.trim() || cleanAudioTitle(file.name)).slice(0, 80);
    const safeBase = title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 35) || "audio";

    const storagePath = `account-${accountId}/audio-${Date.now()}-${safeBase}.${extension}`;

    // 5. Sanitize MIME type for Supabase Storage allowed_mime_types policy
    let cleanMime = (detectedMime || "").split(";")[0].trim().toLowerCase();
    if (!cleanMime || cleanMime === "application/octet-stream" || cleanMime.includes("enc") || cleanMime === "audio/opus") {
      cleanMime = extension === "mp3" ? "audio/mpeg" : "audio/ogg";
    }
    if (cleanMime === "audio/mp3") {
      cleanMime = "audio/mpeg";
    }

    // Upload normalized audio buffer to Supabase Storage
    const { error: uploadErr } = await admin.storage
      .from("chat-media")
      .upload(storagePath, fileBuffer, {
        contentType: cleanMime,
        cacheControl: "31536000",
        upsert: true,
      });

    if (uploadErr) {
      console.error("[audio-upload] Storage upload failed:", uploadErr);
      return NextResponse.json(
        { error: `Falha ao gravar arquivo no storage: ${uploadErr.message || "erro desconhecido"}` },
        { status: 500 }
      );
    }

    const {
      data: { publicUrl },
    } = admin.storage.from("chat-media").getPublicUrl(storagePath);

    // 6. Persist in quick_replies
    const shortcut = rawShortcut?.trim() ? rawShortcut.replace(/^\//, "").trim() : null;
    const category = rawCategory?.trim() || "Áudios";

    const { data: newRow, error: insertErr } = await admin
      .from("quick_replies")
      .insert({
        account_id: accountId,
        user_id: user.id,
        title,
        kind: "audio",
        shortcut,
        category,
        color: "purple",
        content_text: `🎙️ ${title}`,
        media_url: publicUrl,
        media_type: cleanMime,
        media_duration: durationSeconds,
        scope: "team",
      })
      .select("*")
      .single();

    if (insertErr) {
      console.error("[audio-upload] Quick reply DB insert failed:", insertErr);
      return NextResponse.json({ error: "Erro ao cadastrar áudio no sistema." }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      quickReply: newRow,
    });
  } catch (err: unknown) {
    console.error("[audio-upload] Fatal error:", err);
    const message = err instanceof Error ? err.message : "Erro desconhecido ao processar áudio.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
