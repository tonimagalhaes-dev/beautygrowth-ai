/**
 * Response DTO for paginated cache entry listings.
 */
export class CacheEntryListDto {
  data: CacheEntryPreviewDto[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

/**
 * Preview DTO for a single cache entry in a list view.
 */
export class CacheEntryPreviewDto {
  id: string;
  tema: string;
  redesSociais: string[];
  createdAt: string;
  contentPreview: string;
  hasImages: boolean;
}
