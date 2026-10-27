/**
 * Built-in Acrobat-style signature appearance templates.
 */

import type { SignatureAppearance } from './visual-types';

export interface AppearanceTemplate {
  id: string;
  name: string;
  description: string;
  appearance: Omit<SignatureAppearance, 'id'> & { id?: string };
}

const STANDARD: AppearanceTemplate = {
  id: 'standard',
  name: 'Standard',
  description: 'Signature image with name and date',
  appearance: {
    name: 'Standard',
    templateId: 'standard',
    background: { visible: true, color: '#ffffff', opacity: 0.95 },
    border: { visible: true, color: '#334155', width: 1.25, style: 'solid' },
    logo: { visible: false },
    signatureImage: { visible: true },
    typedName: {
      visible: true,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 11,
      color: '#0f172a',
    },
    date: {
      visible: true,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 9,
      color: '#475569',
    },
    reason: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#475569' },
    location: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#475569' },
    contactInfo: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#475569' },
    layout: { padding: 10, alignment: 'left', gap: 4 },
  },
};

const NAME_DATE_REASON: AppearanceTemplate = {
  id: 'name-date-reason',
  name: 'Name · Date · Reason',
  description: 'Full metadata block with signature',
  appearance: {
    name: 'Name · Date · Reason',
    templateId: 'name-date-reason',
    background: { visible: true, color: '#f8fafc', opacity: 1 },
    border: { visible: true, color: '#1e293b', width: 1.5, style: 'solid' },
    logo: { visible: false },
    signatureImage: { visible: true },
    typedName: {
      visible: true,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 12,
      color: '#0f172a',
    },
    date: {
      visible: true,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 9,
      color: '#334155',
    },
    reason: {
      visible: true,
      text: 'I am the author of this document',
      font: 'Helvetica, Arial, sans-serif',
      size: 9,
      color: '#334155',
    },
    location: {
      visible: true,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 9,
      color: '#334155',
    },
    contactInfo: {
      visible: false,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 9,
      color: '#334155',
    },
    layout: { padding: 12, alignment: 'left', gap: 5 },
  },
};

const MINIMAL: AppearanceTemplate = {
  id: 'minimal',
  name: 'Minimal',
  description: 'Signature ink only',
  appearance: {
    name: 'Minimal',
    templateId: 'minimal',
    background: { visible: false, color: '#ffffff', opacity: 0 },
    border: { visible: false, color: '#000000', width: 0, style: 'solid' },
    logo: { visible: false },
    signatureImage: { visible: true },
    typedName: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 10, color: '#000' },
    date: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#000' },
    reason: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#000' },
    location: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#000' },
    contactInfo: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#000' },
    layout: { padding: 4, alignment: 'center', gap: 2 },
  },
};

const LOGO_HEADER: AppearanceTemplate = {
  id: 'logo-header',
  name: 'Logo header',
  description: 'Logo, signature, and contact row',
  appearance: {
    name: 'Logo header',
    templateId: 'logo-header',
    background: { visible: true, color: '#ffffff', opacity: 1 },
    border: { visible: true, color: '#0ea5e9', width: 1.5, style: 'solid' },
    logo: { visible: true, width: 40, height: 40 },
    signatureImage: { visible: true },
    typedName: {
      visible: true,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 11,
      color: '#0f172a',
    },
    date: {
      visible: true,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 9,
      color: '#64748b',
    },
    reason: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#64748b' },
    location: { visible: false, text: '', font: 'Helvetica, Arial, sans-serif', size: 9, color: '#64748b' },
    contactInfo: {
      visible: true,
      text: '',
      font: 'Helvetica, Arial, sans-serif',
      size: 8,
      color: '#64748b',
    },
    layout: { padding: 10, alignment: 'left', gap: 6 },
  },
};

const TEMPLATES: AppearanceTemplate[] = [STANDARD, NAME_DATE_REASON, MINIMAL, LOGO_HEADER];

export function listAppearanceTemplates(): AppearanceTemplate[] {
  return TEMPLATES.map((t) => ({
    ...t,
    appearance: JSON.parse(JSON.stringify(t.appearance)),
  }));
}

export function getAppearanceTemplate(id: string): AppearanceTemplate | null {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) return null;
  return {
    ...t,
    appearance: JSON.parse(JSON.stringify(t.appearance)),
  };
}
