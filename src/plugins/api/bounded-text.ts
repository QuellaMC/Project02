import {truncateText} from '../../shared/text-cut.ts';

/** Ellipsis truncation for model-facing output text. */
export function boundedText(value: string, maxLength: number): string {
  return truncateText(value, maxLength, '...');
}
