import { createClient } from '@supabase/supabase-js';
import { CreativeRenderer } from '../src/lib/creative-engine/renderer';
import fs from 'fs';
import path from 'path';

const env = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
const urlMatch = env.match(/NEXT_PUBLIC_SUPABASE_URL=([^\r\n]+)/);
const keyMatch = env.match(/SUPABASE_SERVICE_ROLE_KEY=([^\r\n]+)/);
const supabase = createClient(urlMatch![1], keyMatch![1]);

const TEMPLATE_ID = 'b7e8d641-5a02-4f76-88c9-cf91b29a5a78';
const ACCOUNT_ID = '4fe971b8-cf70-45e2-8db3-c3eff700ae75';
const USER_ID = '89b3f77f-c808-446d-bd87-221e1b5a75b5';

const templateDefinition = {
  width: 960,
  height: 960,
  background: '#0f172a',
  elements: [
    // 1. BACKGROUND (header_bg)
    {
      id: 'header_bg',
      type: 'ROUNDED_RECTANGLE',
      x: 20,
      y: 20,
      width: 920,
      height: 920,
      fill: '#1e293b',
      stroke: '#334155',
      strokeWidth: 2,
      borderRadius: 24,
      zIndex: 1,
    },
    // 2. TÍTULO (title_text)
    {
      id: 'title_text',
      type: 'TEXT',
      x: 60,
      y: 60,
      width: 840,
      height: 60,
      text: '{{title | uppercase | default("CONFIRMAÇÃO DE PEDIDO")}}',
      fontSize: 34,
      fontWeight: 'bold',
      color: '#38bdf8',
      alignment: 'center',
      zIndex: 10,
    },
    // 3. CLIENTE (client_name)
    {
      id: 'client_name',
      type: 'TEXT',
      x: 60,
      y: 135,
      width: 840,
      height: 40,
      text: 'Destinatário: {{name | capitalize}}',
      fontSize: 26,
      color: '#f8fafc',
      alignment: 'left',
      zIndex: 10,
    },
    // 4. CAIXA DO PEDIDO (code_box)
    {
      id: 'code_box',
      type: 'ROUNDED_RECTANGLE',
      x: 60,
      y: 190,
      width: 840,
      height: 100,
      fill: '#0284c7',
      opacity: 0.9,
      borderRadius: 20,
      zIndex: 5,
    },
    // 5. CÓDIGO (code_text)
    {
      id: 'code_text',
      type: 'TEXT',
      x: 90,
      y: 220,
      width: 780,
      height: 45,
      text: 'Código: #{{code}}',
      fontSize: 30,
      fontWeight: 'bold',
      color: '#ffffff',
      alignment: 'left',
      zIndex: 10,
    },
    // 6. SERVIÇO (service_text)
    {
      id: 'service_text',
      type: 'TEXT',
      x: 60,
      y: 315,
      width: 840,
      height: 40,
      text: 'Serviço: Seguidores Instagram',
      fontSize: 26,
      fontWeight: '600',
      color: '#e2e8f0',
      alignment: 'left',
      zIndex: 10,
    },
    // 7. INSTAGRAM (instagram_text)
    {
      id: 'instagram_text',
      type: 'TEXT',
      x: 60,
      y: 370,
      width: 840,
      height: 40,
      text: 'Instagram: @{{instagram_username}}',
      fontSize: 26,
      fontWeight: '600',
      color: '#38bdf8',
      alignment: 'left',
      zIndex: 10,
    },
    // 8. QUANTIDADE (quantity_text)
    {
      id: 'quantity_text',
      type: 'TEXT',
      x: 60,
      y: 425,
      width: 840,
      height: 40,
      text: 'Quantidade: {{quantity}}',
      fontSize: 26,
      fontWeight: 'bold',
      color: '#4ade80',
      alignment: 'left',
      zIndex: 10,
    },
    // 9. FOTO (el_1789614784235)
    {
      id: 'el_1789614784235',
      type: 'CIRCLE_IMAGE',
      x: 360,
      y: 500,
      width: 240,
      height: 240,
      variable: 'profile_image',
      borderColor: '#38bdf8',
      borderWidth: 4,
      zIndex: 10,
    },
    // 10. RODAPÉ (footer_tag)
    {
      id: 'footer_tag',
      type: 'TEXT',
      x: 60,
      y: 880,
      width: 840,
      height: 40,
      text: 'Automação Visual Determinística • {{date | date}}',
      fontSize: 20,
      alignment: 'center',
      color: '#94a3b8',
      fontWeight: '300',
      zIndex: 10,
    },
  ],
};

async function seedAndTest() {
  console.log('1. Upserting Follower Confirmation Creative Template into database...');

  const row = {
    id: TEMPLATE_ID,
    account_id: ACCOUNT_ID,
    created_by: USER_ID,
    name: 'Confirmação de Pedido — Seguidores',
    description: 'Template determinístico para confirmação de pedidos de seguidores com avatar do Instagram',
    category: 'followers',
    type: 'image/png',
    status: 'ACTIVE',
    version: 1,
    definition: templateDefinition,
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .from('creative_templates')
    .upsert(row);

  if (upsertErr) {
    throw new Error(`Failed to upsert creative template: ${upsertErr.message}`);
  }
  console.log(`Template saved successfully! ID: ${TEMPLATE_ID}, Status: ACTIVE`);

  // Verify retrieval
  const { data: tmpl } = await supabase
    .from('creative_templates')
    .select('*')
    .eq('id', TEMPLATE_ID)
    .single();

  console.log(`Verified from DB: "${tmpl.name}" (status: ${tmpl.status})`);

  // Test rendering
  console.log('\n2. Testing Real Deterministic Render...');
  const testContext = {
    name: 'Cliente Teste',
    instagram_username: 'cristiano',
    quantity: '5.000',
    code: 'PED-5000-CRISTIANO',
    amount: 'R$ 49,90',
    date: new Date().toISOString(),
    profile_image: 'https://pps.whatsapp.net/v/t61.24694-24/684207652_2292565314909544_7297238804182902960_n.jpg?ccb=11-4&oh=01_Q5Aa5gEFK6j48ZEL0NfzqWgappyvWtfesEjOScvLvmHldww5Jw&oe=6AB83225&_nc_sid=5e03e0&_nc_cat=103',
  };

  const renderResult = await CreativeRenderer.render(tmpl.definition, testContext);
  console.log(`Render SUCCESS!`);
  console.log(`Dimensions: ${renderResult.width}x${renderResult.height}`);
  console.log(`PNG Buffer size: ${renderResult.pngBuffer.length} bytes`);
  console.log(`SVG contains circle: ${renderResult.svg.includes('<circle')}`);
  console.log(`SVG contains image: ${renderResult.svg.includes('<image')}`);
  console.log(`SVG contains Cristiano: ${renderResult.svg.includes('cristiano')}`);
  console.log(`SVG contains 5.000: ${renderResult.svg.includes('5.000')}`);
}

seedAndTest().catch(console.error);
