import { createClient as createAdminClient } from '@supabase/supabase-js';

export interface QuickReplyCategory {
  id: string;
  account_id: string;
  name: string;
  description?: string | null;
  icon: string;
  color: string;
  order_index: number;
  is_active: boolean;
  is_system: boolean;
  created_at?: string;
  updated_at?: string;
}

export const DEFAULT_CATEGORIES: Omit<QuickReplyCategory, 'id' | 'account_id'>[] = [
  { name: 'Boas-vindas', description: 'Mensagens de recepção e boas-vindas para novos leads', icon: 'hand-metal', color: '#10B981', order_index: 1, is_active: true, is_system: true },
  { name: 'Apresentação', description: 'Apresentação da empresa, portfólio e serviços', icon: 'sparkles', color: '#3B82F6', order_index: 2, is_active: true, is_system: true },
  { name: 'Qualificação', description: 'Perguntas e critérios para qualificar o perfil do cliente', icon: 'target', color: '#8B5CF6', order_index: 3, is_active: true, is_system: true },
  { name: 'Vendas', description: 'Discursos de venda e conversão de propostas', icon: 'dollar-sign', color: '#F59E0B', order_index: 4, is_active: true, is_system: true },
  { name: 'Preço', description: 'Tabelas de preços, pacotes e orçamentos', icon: 'tag', color: '#EC4899', order_index: 5, is_active: true, is_system: true },
  { name: 'Produtos', description: 'Informações detalhadas sobre catálogo de produtos', icon: 'package', color: '#06B6D4', order_index: 6, is_active: true, is_system: true },
  { name: 'Serviços', description: 'Descrição e escopo dos serviços oferecidos', icon: 'briefcase', color: '#6366F1', order_index: 7, is_active: true, is_system: true },
  { name: 'Pagamento', description: 'Formas de pagamento, chave PIX, cartão e links', icon: 'credit-card', color: '#14B8A6', order_index: 8, is_active: true, is_system: true },
  { name: 'Objeções', description: 'Quebras de objeções comuns de clientes', icon: 'shield-alert', color: '#EF4444', order_index: 9, is_active: true, is_system: true },
  { name: 'Follow-up', description: 'Mensagens de acompanhamento e lembretes', icon: 'clock', color: '#F97316', order_index: 10, is_active: true, is_system: true },
  { name: 'Pós-venda', description: 'Atendimento e suporte após a compra/contratação', icon: 'heart-handshake', color: '#84CC16', order_index: 11, is_active: true, is_system: true },
  { name: 'Suporte', description: 'Respostas para dúvidas técnicas e atendimento ao cliente', icon: 'headphones', color: '#A855F7', order_index: 12, is_active: true, is_system: true },
  { name: 'Documentos', description: 'Envio de contratos, propostas e termos', icon: 'file-text', color: '#64748B', order_index: 13, is_active: true, is_system: true },
  { name: 'Agendamento', description: 'Agendamento de reuniões, visitas ou chamadas', icon: 'calendar', color: '#0EA5E9', order_index: 14, is_active: true, is_system: true },
  { name: 'Reativação', description: 'Recuperação de contatos antigos ou inativos', icon: 'refresh-cw', color: '#E11D48', order_index: 15, is_active: true, is_system: true },
  { name: 'Outros', description: 'Mensagens gerais diversas', icon: 'message-circle', color: '#71717A', order_index: 16, is_active: true, is_system: true },
];

function supabaseAdmin() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * Fetch categories for an account. If the table exists and is empty, seeds default categories.
 * If the table does not exist in Supabase yet, returns standard categories gracefully.
 */
export async function getAccountCategories(accountId: string): Promise<QuickReplyCategory[]> {
  try {
    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from('quick_reply_categories')
      .select('*')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .order('order_index', { ascending: true });

    if (error) {
      // Table doesn't exist yet in Supabase schema cache
      console.warn('[categories] Fallback to default categories:', error.message);
      return DEFAULT_CATEGORIES.map((cat, idx) => ({
        id: `def-${idx + 1}`,
        account_id: accountId,
        ...cat,
      }));
    }

    if (data && data.length > 0) {
      return data as QuickReplyCategory[];
    }

    // Seed default categories for this account
    const toInsert = DEFAULT_CATEGORIES.map((cat) => ({
      account_id: accountId,
      name: cat.name,
      description: cat.description,
      icon: cat.icon,
      color: cat.color,
      order_index: cat.order_index,
      is_active: cat.is_active,
      is_system: cat.is_system,
    }));

    const { data: seeded, error: seedErr } = await admin
      .from('quick_reply_categories')
      .insert(toInsert)
      .select('*')
      .order('order_index', { ascending: true });

    if (!seedErr && seeded) {
      return seeded as QuickReplyCategory[];
    }

    return DEFAULT_CATEGORIES.map((cat, idx) => ({
      id: `def-${idx + 1}`,
      account_id: accountId,
      ...cat,
    }));
  } catch (err) {
    console.warn('[categories] Error fetching categories, fallback:', err);
    return DEFAULT_CATEGORIES.map((cat, idx) => ({
      id: `def-${idx + 1}`,
      account_id: accountId,
      ...cat,
    }));
  }
}
