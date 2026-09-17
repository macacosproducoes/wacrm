/**
 * Creative Engine - Core Type Definitions
 *
 * Generic, reusable, multi-tenant creative generation architecture.
 * Independent of specific commercial niches, products, or brands.
 */

export type CreativeElementType =
  | 'TEXT'
  | 'IMAGE'
  | 'CIRCLE_IMAGE'
  | 'RECTANGLE'
  | 'ROUNDED_RECTANGLE'
  | 'LINE'
  | 'GROUP'
  | 'LOGO';

export type TextAlignment = 'left' | 'center' | 'right';
export type ImageFit = 'cover' | 'contain' | 'fill';
export type ImagePosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

export interface BaseCreativeElement {
  id: string;
  type: CreativeElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  zIndex?: number;
}

export interface TextElement extends BaseCreativeElement {
  type: 'TEXT';
  text?: string;
  variable?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string | number;
  color?: string;
  alignment?: TextAlignment;
  lineHeight?: number;
  letterSpacing?: number;
  maxWidth?: number;
}

export interface ImageElement extends BaseCreativeElement {
  type: 'IMAGE' | 'LOGO';
  source?: string;
  variable?: string;
  fit?: ImageFit;
  position?: ImagePosition;
  borderRadius?: number;
  fallbackUrl?: string;
}

export interface CircleImageElement extends BaseCreativeElement {
  type: 'CIRCLE_IMAGE';
  source?: string;
  variable?: string;
  fallbackUrl?: string;
  borderColor?: string;
  borderWidth?: number;
}

export interface ShapeElement extends BaseCreativeElement {
  type: 'RECTANGLE' | 'ROUNDED_RECTANGLE';
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  borderRadius?: number;
}

export interface LineElement extends BaseCreativeElement {
  type: 'LINE';
  x2: number;
  y2: number;
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: string;
}

export interface GroupElement extends BaseCreativeElement {
  type: 'GROUP';
  children: CreativeElement[];
}

export type CreativeElement =
  | TextElement
  | ImageElement
  | CircleImageElement
  | ShapeElement
  | LineElement
  | GroupElement;

export interface VariableDefinition {
  key: string;
  label?: string;
  description?: string;
  defaultValue?: string | number;
  exampleValue?: string | number;
  required?: boolean;
  type?: 'string' | 'number' | 'currency' | 'date' | 'image_url';
}

export interface TemplateBackground {
  type: 'color' | 'image' | 'gradient';
  value: string;
}

export interface TemplateDefinition {
  width: number;
  height: number;
  background: string | TemplateBackground;
  elements: CreativeElement[];
  variables?: VariableDefinition[];
  metadata?: Record<string, unknown>;
}

export type TemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface CreativeTemplate {
  id: string;
  account_id: string;
  created_by?: string | null;
  name: string;
  description?: string | null;
  category: string;
  type: string;
  status: TemplateStatus;
  version: number;
  definition: TemplateDefinition;
  created_at: string;
  updated_at: string;
}

export interface CreativeTemplateVersion {
  id: string;
  template_id: string;
  account_id: string;
  created_by?: string | null;
  version: number;
  definition: TemplateDefinition;
  created_at: string;
}

export type JobStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'GENERATED'
  | 'READY'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'NEEDS_REVIEW'
  | 'CANCELLED';

export type SourceType =
  | 'ORDER'
  | 'CONTACT'
  | 'LEAD'
  | 'CAMPAIGN'
  | 'AUTOMATION'
  | 'CONVERSATION'
  | 'CUSTOM'
  | 'MANUAL'
  | string;

export interface CreativeJob {
  id: string;
  account_id: string;
  template_id: string;
  template_version: number;
  source_type: SourceType;
  source_id: string;
  creative_type: string;
  idempotency_key: string;
  input_data: Record<string, unknown>;
  output_url?: string | null;
  output_path?: string | null;
  status: JobStatus;
  error?: string | null;
  attempts: number;
  max_attempts: number;
  locked_at?: string | null;
  locked_by?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  sent_at?: string | null;
}

export interface CreativeDelivery {
  id: string;
  account_id: string;
  job_id: string;
  channel: string;
  recipient: string;
  provider: string;
  provider_message_id?: string | null;
  status: 'PENDING' | 'SENT' | 'FAILED';
  error?: string | null;
  created_at: string;
  sent_at?: string | null;
}

export interface DeliveryOptions {
  channel?: string;
  recipient: string;
  provider?: string;
  caption?: string;
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  success: boolean;
  deliveryId?: string;
  providerMessageId?: string;
  error?: string;
}
