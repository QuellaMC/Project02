import type {MemoryRecallItem} from './types.ts';

export const memoryProviderMaxItems = 5;
export const memoryProviderMaxTextLength = 600;
export const memoryProviderMaxSourceReferences = 5;

export function boundedMemoryItems(
  items: readonly MemoryRecallItem[],
): readonly MemoryRecallItem[] {
  return Object.freeze(
    items.slice(0, memoryProviderMaxItems).map(item =>
      Object.freeze({
        id: boundedText(item.id, 120),
        text: boundedText(item.text, memoryProviderMaxTextLength),
        sourceReferences: Object.freeze(
          item.sourceReferences.slice(0, memoryProviderMaxSourceReferences),
        ),
        ...(item.confidence === undefined ? {} : {confidence: item.confidence}),
      } satisfies MemoryRecallItem),
    ),
  );
}

export function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}
