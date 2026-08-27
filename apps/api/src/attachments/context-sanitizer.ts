import type { AttachmentRecord } from './attachments.types';
import { sanitizeImageRecommendedIntent } from './image-analysis';

export type AttachmentContextPurpose = 'classifyIntent' | 'generateReply' | 'qualityReview' | 'knowledgeExtract';

export type SanitizedAttachmentContext = {
  includedDataClasses: string[];
  excludedPII: string[];
  attachments: Array<{
    id: string;
    mimeType: string;
    size: number;
    analysis?: {
      scene: string;
      observations: string[];
      confidence: number;
      requiresHuman: boolean;
      containsPII?: boolean;
      recommendedIntent?: string;
    };
  }>;
};

/**
 * Convert attachment metadata into the bounded context shape sent to an AI
 * provider.  Raw bytes, object keys, signed URLs, filenames, and OCR text are
 * intentionally never part of this output.  Images also never become
 * knowledge automatically: knowledgeExtract receives no attachment context.
 */
export function sanitizeAttachmentContext(
  records: readonly AttachmentRecord[],
  purpose: AttachmentContextPurpose,
): SanitizedAttachmentContext {
  const excludedPII = [
    'raw_binary',
    'object_key',
    'signed_url',
    'original_filename',
    'workspace_token',
    'complete_phone',
    'complete_address',
    'payment_information',
  ];
  if (purpose === 'knowledgeExtract') {
    return {
      includedDataClasses: [],
      excludedPII: [...excludedPII, 'image_analysis', 'ocr_text'],
      attachments: [],
    };
  }

  const attachments = records
    .filter((record) => record.status === 'ACTIVE')
    .slice(0, 8)
    .map((record) => {
      const result: SanitizedAttachmentContext['attachments'][number] = {
        id: record.id,
        mimeType: record.mimeType,
        size: record.size,
      };
      const analysis = record.analysisJson;
      if (analysis) {
        const recommendedIntent = sanitizeImageRecommendedIntent(analysis.recommendedIntent);
        result.analysis = {
          scene: analysis.scene,
          observations: record.containsPII || analysis.containsPII ? [] : analysis.observations.slice(0, 12),
          confidence: analysis.confidence,
          requiresHuman: record.containsPII || analysis.requiresHuman,
          ...(record.containsPII || analysis.containsPII ? { containsPII: true } : {}),
          ...(recommendedIntent ? { recommendedIntent } : {}),
        };
      }
      return result;
    });
  return {
    includedDataClasses: ['attachment.metadata', 'image.analysis'],
    excludedPII,
    attachments,
  };
}

export class ContextSanitizer {
  sanitize(records: readonly AttachmentRecord[], purpose: AttachmentContextPurpose): SanitizedAttachmentContext {
    return sanitizeAttachmentContext(records, purpose);
  }
}
