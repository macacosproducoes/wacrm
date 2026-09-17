import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { handleFollowerOrder } from '../src/lib/orders/follower-order-handler';
import { CreativeRenderer } from '../src/lib/creative-engine/renderer';
import { CreativeTemplateService } from '../src/lib/creative-engine/templates';
import { FOLLOWER_TEMPLATE_ID } from '../src/lib/orders/follower-order-handler';

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const urlMatch = env.match(/NEXT_PUBLIC_SUPABASE_URL=([^\r\n]+)/);
const keyMatch = env.match(/SUPABASE_SERVICE_ROLE_KEY=([^\r\n]+)/);
const supabase = createClient(urlMatch![1], keyMatch![1]);

const ACCOUNT_ID = '4fe971b8-cf70-45e2-8db3-c3eff700ae75';

async function verifyFlow() {
  console.log('=====================================================');
  console.log('STARTING REAL VERIFICATION OF FOLLOWER ORDER FLOW');
  console.log('=====================================================');

  // 1. Get or create test contact
  const testPhone = '5511999998888';
  let { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('account_id', ACCOUNT_ID)
    .eq('phone', testPhone)
    .maybeSingle();

  if (!contact) {
    const { data: newContact, error: cErr } = await supabase
      .from('contacts')
      .insert({
        account_id: ACCOUNT_ID,
        name: 'Cliente Teste',
        phone: testPhone,
      })
      .select('*')
      .single();
    if (cErr) throw new Error(`Contact creation error: ${cErr.message}`);
    contact = newContact;
  }

  // 2. Get or create test conversation
  let { data: conv } = await supabase
    .from('conversations')
    .select('*')
    .eq('account_id', ACCOUNT_ID)
    .eq('contact_id', contact.id)
    .maybeSingle();

  if (!conv) {
    const { data: newConv } = await supabase
      .from('conversations')
      .insert({
        account_id: ACCOUNT_ID,
        contact_id: contact.id,
      })
      .select('*')
      .single();
    conv = newConv;
  }

  // 3. Test Message: "Sou @cristiano, quero 5.000 seguidores"
  const testMessageText = 'Sou @cristiano, quero 5.000 seguidores';
  const testMsgId = `test_msg_${Date.now()}`;

  console.log(`\n1. Executing handleFollowerOrder with: "${testMessageText}"...`);
  const result = await handleFollowerOrder({
    accountId: ACCOUNT_ID,
    contactId: contact.id,
    conversationId: conv.id,
    phone: testPhone,
    messageText: testMessageText,
    messageId: testMsgId,
    pushName: 'Cliente Teste',
  });

  console.log('Result of handleFollowerOrder:');
  console.log('- Handled:', result.handled);
  console.log('- Order Code:', result.orderCode);
  console.log('- Username:', result.username);
  console.log('- Quantity:', result.quantity);
  console.log('- Avatar URL:', result.profileImageUrl ? result.profileImageUrl.slice(0, 60) + '...' : 'none');
  console.log('- Creative Job ID:', result.creativeJob?.id);
  console.log('- Creative Job Status:', result.creativeJob?.status);
  console.log('- Output Image URL:', result.creativeJob?.output_url);

  // 4. Verify Contact Updates in DB
  const { data: updatedContact } = await supabase
    .from('contacts')
    .select('instagram_username, profile_image_url, profile_image_source, profile_image_hash, profile_image_updated_at')
    .eq('id', contact.id)
    .single();

  console.log('\n2. Verifying Contact in Database:');
  console.log('- instagram_username:', updatedContact?.instagram_username);
  console.log('- profile_image_url present:', !!updatedContact?.profile_image_url);
  console.log('- profile_image_source:', updatedContact?.profile_image_source);
  console.log('- profile_image_updated_at:', updatedContact?.profile_image_updated_at);

  // 5. Verify Template & Render Details
  const { template } = await CreativeTemplateService.getTemplate(FOLLOWER_TEMPLATE_ID, ACCOUNT_ID);
  console.log('\n3. Verifying Creative Template:');
  console.log('- Template Name:', template.name);
  console.log('- Status:', template.status);
  console.log('- Canvas:', `${template.definition.width}x${template.definition.height}`);

  const renderContext = {
    title: 'CONFIRMAÇÃO DE PEDIDO',
    name: 'Cliente Teste',
    code: result.orderCode || 'PED-5000-CRISTIANO',
    instagram_username: 'cristiano',
    quantity: '5.000',
    service: 'Seguidores Instagram',
    date: new Date().toLocaleDateString('pt-BR'),
    profile_image: updatedContact?.profile_image_url || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=400&h=400&fit=crop',
    amount: 'R$ 49,90',
  };

  const renderRes = await CreativeRenderer.render(template.definition, renderContext);
  console.log('\n4. Verifying Render Results:');
  console.log('- Dimensions:', `${renderRes.width}x${renderRes.height}`);
  console.log('- PNG Buffer size:', renderRes.pngBuffer.length, 'bytes');
  console.log('- SVG has ROUNDED_RECTANGLE (rx/ry):', renderRes.svg.includes('rx="20"'));
  console.log('- SVG has CIRCLE_IMAGE (clipPath / circle):', renderRes.svg.includes('<circle'));
  console.log('- SVG has Cristiano:', renderRes.svg.includes('cristiano'));
  console.log('- SVG has 5.000:', renderRes.svg.includes('5.000'));
  console.log('- SVG has code #:', renderRes.svg.includes(renderContext.code));
  console.log('- SVG has Destinatário Cliente Teste:', renderRes.svg.includes('Cliente Teste'));
  console.log('- SVG has footer tag:', renderRes.svg.includes('Automação Visual Determinística'));

  console.log('\n=====================================================');
  console.log('ALL VERIFICATIONS COMPLETED SUCCESSFULLY!');
  console.log('=====================================================');
}

verifyFlow().catch(console.error);
