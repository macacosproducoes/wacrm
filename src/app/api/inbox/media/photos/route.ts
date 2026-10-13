import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp"];

function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * GET /api/inbox/media/photos
 * Lists all registered photos from Supabase Storage (chat-media) and quick_replies.
 */
export async function GET() {
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: "NÃ£o autenticado." }, { status: 401 });
    }

    const admin = getAdminClient();
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/+$/, "");

    // Get user account_id if available
    const { data: profile } = await supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", user.id)
      .maybeSingle();

    const accountId = profile?.account_id;
    const photosMap = new Map<string, {
      id: string;
      name: string;
      path: string;
      url: string;
      size?: number;
      created_at: string;
      title?: string;
    }>();

    // 1. Scan storage bucket 'chat-media'
    const { data: rootItems } = await admin.storage.from("chat-media").list("", { limit: 100 });

    if (rootItems) {
      for (const item of rootItems) {
        if (!item.id) {
          // Folder (e.g. account-<accountId>)
          // If accountId is known, prioritize that folder, but also allow all for admin/team
          const { data: subItems } = await admin.storage.from("chat-media").list(item.name, {
            limit: 100,
            sortBy: { column: "created_at", order: "desc" },
          });

          if (subItems) {
            for (const sub of subItems) {
              if (isImageFile(sub.name)) {
                const fullPath = `${item.name}/${sub.name}`;
                const publicUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${encodeURI(fullPath)}`;
                // Clean display name
                let cleanName = sub.name.replace(/^\d+[-_]/, "").replace(/[-_]/g, " ");
                if (cleanName.length > 40) cleanName = cleanName.substring(0, 40) + "...";

                photosMap.set(publicUrl, {
                  id: sub.id || fullPath,
                  name: cleanName || sub.name,
                  path: fullPath,
                  url: publicUrl,
                  size: sub.metadata?.size,
                  created_at: sub.created_at || new Date().toISOString(),
                });
              }
            }
          }
        } else if (isImageFile(item.name)) {
          const publicUrl = `${supabaseUrl}/storage/v1/object/public/chat-media/${encodeURI(item.name)}`;
          let cleanName = item.name.replace(/^\d+[-_]/, "").replace(/[-_]/g, " ");

          photosMap.set(publicUrl, {
            id: item.id || item.name,
            name: cleanName || item.name,
            path: item.name,
            url: publicUrl,
            size: item.metadata?.size,
            created_at: item.created_at || new Date().toISOString(),
          });
        }
      }
    }

    // 2. Scan quick_replies for any additional image URLs
    const { data: imageReplies } = await admin
      .from("quick_replies")
      .select("id, title, media_url, created_at")
      .eq("kind", "image")
      .not("media_url", "is", null);

    if (imageReplies) {
      for (const qr of imageReplies) {
        if (qr.media_url && !photosMap.has(qr.media_url)) {
          photosMap.set(qr.media_url, {
            id: qr.id,
            name: qr.title || "Foto Cadastrada",
            path: qr.media_url,
            url: qr.media_url,
            created_at: qr.created_at || new Date().toISOString(),
            title: qr.title,
          });
        }
      }
    }

    // Convert map to array and sort descending by created_at
    const photos = Array.from(photosMap.values()).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );

    return NextResponse.json(
      {
        success: true,
        photos,
      },
      {
        headers: {
          "Cache-Control": "private, max-age=60, stale-while-revalidate=120",
        },
      }
    );
  } catch (err: any) {
    console.error("[API /api/inbox/media/photos GET] Error:", err);
    return NextResponse.json(
      { error: "Erro ao buscar fotos cadastradas." },
      { status: 500 }
    );
  }
}

/**
 * POST /api/inbox/media/photos
 * Uploads a new photo to chat-media bucket and returns the public URL.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabase();
    const {
      data: { user },
      error: userErr,
    } = await supabase.auth.getUser();

    if (userErr || !user) {
      return NextResponse.json({ error: "NÃ£o autenticado." }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", user.id)
      .maybeSingle();

    const accountId = profile?.account_id;
    if (!accountId) {
      return NextResponse.json(
        { error: "Conta nÃ£o encontrada para o usuÃ¡rio." },
        { status: 400 }
      );
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const title = (formData.get("title") as string) || "";

    if (!file) {
      return NextResponse.json({ error: "Nenhum arquivo enviado." }, { status: 400 });
    }

    const admin = getAdminClient();
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const ext = file.name.split(".").pop() || "png";
    const cleanFileName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
    const storagePath = `account-${accountId}/${Date.now()}-${cleanFileName}`;

    const { error: uploadErr } = await admin.storage
      .from("chat-media")
      .upload(storagePath, buffer, {
        contentType: file.type || ("image/" + ext),
        cacheControl: "31536000, immutable",
        upsert: true,
      });

    if (uploadErr) {
      console.error("[API /api/inbox/media/photos POST] Upload error:", uploadErr);
      return NextResponse.json({ error: "Erro ao salvar foto no Storage." }, { status: 500 });
    }

    const {
      data: { publicUrl },
    } = admin.storage.from("chat-media").getPublicUrl(storagePath);

    return NextResponse.json({
      success: true,
      url: publicUrl,
      path: storagePath,
      name: title || file.name,
    });
  } catch (err: any) {
    console.error("[API /api/inbox/media/photos POST] Unexpected error:", err);
    return NextResponse.json(
      { error: "Erro interno ao processar upload da foto." },
      { status: 500 }
    );
  }
}


