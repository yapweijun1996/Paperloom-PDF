/**
 * Acrobat-style signature appearance builder.
 * Builds reusable appearance objects independent of page rendering.
 */

import type {
  SignatureAppearance,
  AppearanceTextComponent,
  AppearanceBackgroundComponent,
  AppearanceBorderComponent,
  AppearanceImageComponent,
  SignatureAppearanceLayout,
} from './visual-types';
import { nextSignatureId } from './signature-model';
import { getAppearanceTemplate, listAppearanceTemplates } from './appearance-templates';

function defaultText(text = ''): AppearanceTextComponent {
  return {
    visible: Boolean(text),
    text,
    font: 'Helvetica, Arial, sans-serif',
    size: 10,
    color: '#1a1a2e',
  };
}

function defaultBg(): AppearanceBackgroundComponent {
  return { visible: true, color: '#ffffff', opacity: 1 };
}

function defaultBorder(): AppearanceBorderComponent {
  return { visible: true, color: '#1a1a2e', width: 1.5, style: 'solid' };
}

function defaultImage(): AppearanceImageComponent {
  return { visible: false };
}

function defaultLayout(): SignatureAppearanceLayout {
  return { padding: 10, alignment: 'left', gap: 6 };
}

export interface BuildAppearanceInput {
  name?: string;
  templateId?: string;
  signatureImageDataUrl?: string;
  logoDataUrl?: string;
  typedName?: string;
  date?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  background?: Partial<AppearanceBackgroundComponent>;
  border?: Partial<AppearanceBorderComponent>;
  layout?: Partial<SignatureAppearanceLayout>;
  /** Show/hide overrides after template merge. */
  visibility?: Partial<Record<
    | 'background'
    | 'border'
    | 'logo'
    | 'signatureImage'
    | 'typedName'
    | 'date'
    | 'reason'
    | 'location'
    | 'contactInfo',
    boolean
  >>;
}

/** Build a reusable appearance from defaults, optional template, and overrides. */
export function buildSignatureAppearance(input: BuildAppearanceInput = {}): SignatureAppearance {
  const template = input.templateId ? getAppearanceTemplate(input.templateId) : null;
  const base: SignatureAppearance = template
    ? {
        ...(JSON.parse(JSON.stringify(template.appearance)) as Omit<SignatureAppearance, 'id'>),
        id: nextSignatureId('ap'),
        name: template.appearance.name || template.name,
      }
    : {
        id: nextSignatureId('ap'),
        name: input.name ?? 'Custom appearance',
        background: defaultBg(),
        border: defaultBorder(),
        logo: defaultImage(),
        signatureImage: defaultImage(),
        typedName: defaultText(),
        date: defaultText(),
        reason: defaultText(),
        location: defaultText(),
        contactInfo: defaultText(),
        layout: defaultLayout(),
      };

  base.id = nextSignatureId('ap');
  if (input.name) base.name = input.name;
  if (input.templateId) base.templateId = input.templateId;

  if (input.signatureImageDataUrl) {
    base.signatureImage = {
      ...base.signatureImage,
      visible: true,
      imageDataUrl: input.signatureImageDataUrl,
    };
  }
  if (input.logoDataUrl) {
    base.logo = {
      ...base.logo,
      visible: true,
      imageDataUrl: input.logoDataUrl,
      width: base.logo.width ?? 36,
      height: base.logo.height ?? 36,
    };
  }
  if (input.typedName != null) {
    base.typedName = { ...base.typedName, text: input.typedName, visible: true };
  }
  if (input.date != null) {
    base.date = { ...base.date, text: input.date, visible: true };
  }
  if (input.reason != null) {
    base.reason = { ...base.reason, text: input.reason, visible: true };
  }
  if (input.location != null) {
    base.location = { ...base.location, text: input.location, visible: true };
  }
  if (input.contactInfo != null) {
    base.contactInfo = { ...base.contactInfo, text: input.contactInfo, visible: true };
  }
  if (input.background) base.background = { ...base.background, ...input.background };
  if (input.border) base.border = { ...base.border, ...input.border };
  if (input.layout) base.layout = { ...base.layout, ...input.layout };

  if (input.visibility) {
    for (const [key, vis] of Object.entries(input.visibility)) {
      if (vis == null) continue;
      const comp = (base as unknown as Record<string, { visible: boolean }>)[key];
      if (comp && typeof comp === 'object' && 'visible' in comp) {
        comp.visible = vis;
      }
    }
  }

  return base;
}

export function cloneAppearance(appearance: SignatureAppearance): SignatureAppearance {
  const copy = structuredCloneAppearance(appearance);
  copy.id = nextSignatureId('ap');
  copy.name = `${appearance.name} copy`;
  return copy;
}

export function setAppearanceComponentVisible(
  appearance: SignatureAppearance,
  component: keyof Omit<SignatureAppearance, 'id' | 'name' | 'templateId' | 'layout'>,
  visible: boolean,
): SignatureAppearance {
  const next = structuredCloneAppearance(appearance);
  const comp = next[component];
  if (comp && typeof comp === 'object' && 'visible' in comp) {
    (comp as { visible: boolean }).visible = visible;
  }
  return next;
}

export function updateAppearanceLayout(
  appearance: SignatureAppearance,
  layout: Partial<SignatureAppearanceLayout>,
): SignatureAppearance {
  return {
    ...structuredCloneAppearance(appearance),
    layout: { ...appearance.layout, ...layout },
  };
}

export { listAppearanceTemplates, getAppearanceTemplate };

function structuredCloneAppearance(a: SignatureAppearance): SignatureAppearance {
  return JSON.parse(JSON.stringify(a)) as SignatureAppearance;
}
