# Implementation Plan: Prompt/Response Cache

## Overview

Implement a persistent prompt/response cache layer that intercepts the content generation flow, returns cached results for exact/similar prompt matches, and provides a History Panel for browsing past generations. The implementation follows the existing NestJS + TypeORM backend and React + TanStack Query frontend patterns.

## Tasks

- [x] 1. Set up module structure, entity, and migration
  - [x] 1.1 Create PromptCacheEntry entity and PromptCacheModule
    - Create `src/modules/prompt-cache/` directory structure
    - Implement `PromptCacheEntry` TypeORM entity with all columns, indexes, and decorators as specified in the design
    - Create `prompt-cache.module.ts` registering the entity, services, and controller
    - Create interfaces file with `CacheLookupResult`, `PaginatedCacheEntries`, `CacheEntryPreview`, `CacheEntryDetailResponse`, `ConfirmSimilarMatchDto`, `ContentAgentResponseWithMeta`
    - _Requirements: 1.3, 1.4, 6.1_

  - [x] 1.2 Create database migration for prompt_cache_entries table
    - Write TypeORM migration creating the `prompt_cache_entries` table with all columns
    - Add unique composite index `(tenant_id, fingerprint)`
    - Add index `(tenant_id, created_at DESC)` for chronological listing
    - Enable Row-Level Security with `prompt_cache_tenant_isolation` policy
    - Enable `pg_trgm` extension and add GIN trigram index on `normalized_tema`
    - _Requirements: 1.3, 6.2_

- [x] 2. Implement fingerprint and cache services
  - [x] 2.1 Implement PromptFingerprintService
    - Create `src/modules/prompt-cache/services/prompt-fingerprint.service.ts`
    - Implement `computeFingerprint()` with SHA-256 hashing of normalized parameters
    - Implement `normalize()` with lowercase, trim, whitespace collapse for text fields, sorted redesSociais, and null handling
    - Implement `getNormalizedTema()` for similar match comparison
    - _Requirements: 2.1_

  - [ ]* 2.2 Write property test for fingerprint determinism
    - **Property 1: Fingerprint Determinism**
    - Use fast-check to generate arbitrary valid prompt parameters and verify that `computeFingerprint` always returns the same hash for the same input
    - **Validates: Requirements 2.1**

  - [x] 2.3 Implement PromptCacheService core logic
    - Create `src/modules/prompt-cache/services/prompt-cache.service.ts`
    - Implement `checkCacheOrGenerate()` with exact match lookup, similar match fallback, and miss handling
    - Implement `persistCacheEntry()` for saving new cache entries after generation
    - Implement `associateImages()` for linking designer-agent image references to cache entries
    - Implement `findSimilarMatch()` using `pg_trgm` similarity with configurable threshold from env variable `PROMPT_CACHE_SIMILARITY_THRESHOLD`
    - Implement `incrementHitCount()` on cache hits
    - Add error handling: cache failures are non-blocking, log warnings and proceed with generation
    - _Requirements: 1.1, 1.2, 2.2, 2.3, 2.4, 3.1, 3.3, 3.4_

  - [ ]* 2.4 Write property test for cache round-trip
    - **Property 2: Cache Round-Trip**
    - Use fast-check to generate arbitrary valid prompt parameters and response payloads, persist them, then verify exact-match lookup returns the same payload
    - **Validates: Requirements 1.1, 2.2**

  - [ ]* 2.5 Write property test for tenant isolation
    - **Property 3: Tenant Isolation**
    - Use fast-check to generate two distinct tenant UUIDs and a cache entry, verify that querying with the wrong tenant never returns the entry
    - **Validates: Requirements 1.4, 6.1, 6.2, 6.3**

  - [ ]* 2.6 Write property test for source metadata correctness
    - **Property 4: Source Metadata Correctness**
    - Use fast-check to verify that cache hits always return `source: "cache"` with zero tokens, and misses return `source: "generated"`
    - **Validates: Requirements 2.3, 2.4, 7.1, 7.2**

  - [ ]* 2.7 Write property test for similar match subsumption
    - **Property 5: Similar Match Subsumption**
    - Use fast-check to verify that any prompt producing an exact match is never classified as a similar match
    - **Validates: Requirements 2.2, 3.1**

- [ ] 3. Implement pagination and controller
  - [x] 3.1 Implement paginated listing in PromptCacheService
    - Add `listEntries(tenantId, page, limit)` method with `ORDER BY created_at DESC` and offset pagination
    - Return `PaginatedCacheEntries` with `total`, `hasMore`, and `CacheEntryPreview` items
    - Add `getEntry(tenantId, id)` method returning full `CacheEntryDetailResponse`
    - _Requirements: 4.1, 4.2, 4.4_

  - [ ]* 3.2 Write property test for chronological ordering invariant
    - **Property 6: Chronological Ordering Invariant**
    - Use fast-check to generate cache entries with varying timestamps and verify that listing always returns them in descending `createdAt` order
    - **Validates: Requirements 4.1**

  - [ ]* 3.3 Write property test for pagination bounds
    - **Property 7: Pagination Bounds**
    - Use fast-check to generate N entries and verify that paginating with page size L returns at most L per page and total entries across all pages equals N
    - **Validates: Requirements 4.4**

  - [x] 3.4 Implement PromptCacheController
    - Create `src/modules/prompt-cache/controllers/prompt-cache.controller.ts`
    - Implement `GET /api/prompt-cache/entries` with pagination query params (page, limit)
    - Implement `GET /api/prompt-cache/entries/:id` returning full cache entry details
    - Implement `POST /api/prompt-cache/confirm-similar` for confirm/decline similar match flow
    - Apply `TenantGuard` to all endpoints
    - Create DTOs: `cache-lookup-response.dto.ts`, `confirm-similar-match.dto.ts`, `cache-entry-list.dto.ts`
    - _Requirements: 3.2, 3.3, 3.4, 4.1, 4.4_

- [x] 4. Checkpoint - Backend services complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Integrate with existing ContentAgent and DesignerAgent flows
  - [x] 5.1 Integrate cache check into ContentAgent generate flow
    - Modify `ContentAgentService.generate()` (or its controller) to call `PromptCacheService.checkCacheOrGenerate()` before invoking the AI
    - On exact match: return cached response with `source: "cache"` and zero tokens
    - On similar match: return cached response with `confirmationRequired: true` and `cacheEntryId`
    - On miss: proceed with normal generation, then call `persistCacheEntry()` on success
    - Add `source` and `confirmationRequired` fields to the generate response DTO
    - _Requirements: 2.2, 2.3, 2.4, 3.1, 7.1, 7.2_

  - [x] 5.2 Integrate image association with DesignerAgent flow
    - After `DesignerAgentService` completes image generation, call `PromptCacheService.associateImages()` with the executionId, tenantId, and image references
    - _Requirements: 1.2_

  - [ ]* 5.3 Write integration tests for generate flow with cache
    - Test exact match returns cached response without calling ContentAgent
    - Test similar match returns confirmation flag
    - Test miss proceeds with generation and persists entry
    - Test image association after designer-agent completion
    - _Requirements: 1.1, 1.2, 2.2, 3.1_

- [x] 6. Checkpoint - Backend integration complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement frontend cache hook and API service
  - [x] 7.1 Create prompt-cache API service and usePromptCache hook
    - Create `frontend/src/services/promptCacheService.ts` with methods: `listEntries`, `getEntry`, `confirmSimilarMatch`
    - Create `frontend/src/hooks/usePromptCache.ts` using `useInfiniteQuery` for paginated entries, `useMutation` for confirmSimilar and getEntry
    - Configure query keys: `['prompt-cache', 'entries']`
    - _Requirements: 4.4, 3.2, 3.3_

  - [x] 7.2 Modify useContentAgent to handle cache response metadata
    - Update the generate mutation's `onSuccess` handler to detect `confirmationRequired` and `source` fields
    - Add state management for triggering `SimilarMatchConfirmation` dialog
    - _Requirements: 2.3, 3.2, 7.3_

- [x] 8. Implement frontend UI components
  - [x] 8.1 Implement CacheSourceBadge component
    - Create `frontend/src/components/CacheSourceBadge.tsx`
    - Display green "Cache" badge for `source: "cache"` responses
    - Display blue "Gerado" badge for `source: "generated"` responses
    - Integrate into `ResultPanel` component
    - _Requirements: 7.3_

  - [x] 8.2 Implement HistoryPanel component
    - Create `frontend/src/components/HistoryPanel.tsx` using shadcn/ui `Sheet` component
    - Render chronologically ordered list of `CacheEntryCard` items
    - Implement infinite scroll with "Load more" button using `useInfiniteQuery`
    - Display empty state message when no entries exist
    - Add "Usar" (select) and "Refinar" (refine) action buttons per entry
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [x] 8.3 Implement CacheEntryCard component
    - Create `frontend/src/components/CacheEntryCard.tsx`
    - Display tema (truncated to 80 chars), redesSociais as badge chips, createdAt as relative time, content preview (first 120 chars)
    - Include "Usar" and "Refinar" action buttons
    - _Requirements: 4.2, 4.3_

  - [x] 8.4 Implement SimilarMatchConfirmation dialog
    - Create `frontend/src/components/SimilarMatchConfirmation.tsx` using shadcn/ui `Dialog`
    - Show similar cached result preview with similarity indicator
    - "Usar resultado anterior" button calls `confirmSimilarMatch({ confirmed: true })`
    - "Gerar novo conteúdo" button calls `confirmSimilarMatch({ confirmed: false })` then triggers new generation
    - _Requirements: 3.2, 3.3, 3.4_

  - [x] 8.5 Integrate HistoryPanel and refinement flow
    - Add History Panel toggle button to the main layout
    - Wire `onSelectEntry` to load cached response into ResultPanel
    - Wire `onRefineEntry` to open RefinementOverlay pre-loaded with cached execution context
    - Ensure briefing form fields are NOT pre-filled when loading cached entry for refinement
    - _Requirements: 4.3, 5.1, 5.2, 5.3, 5.4_

  - [ ]* 8.6 Write unit tests for frontend cache components
    - Test HistoryPanel renders entries, empty state, and pagination
    - Test SimilarMatchConfirmation confirm/decline behavior
    - Test CacheSourceBadge displays correct visual per source type
    - Test usePromptCache hook with mocked API responses
    - _Requirements: 4.1, 4.5, 3.2, 7.3_

- [x] 9. Final checkpoint - Full feature complete
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties using fast-check
- Unit tests validate specific examples and edge cases
- The cache layer is non-blocking — failures never prevent content generation
- All cache queries enforce tenant scoping at application, query, and RLS levels

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "2.5", "2.6", "2.7", "3.1"] },
    { "id": 4, "tasks": ["3.2", "3.3", "3.4"] },
    { "id": 5, "tasks": ["5.1", "5.2"] },
    { "id": 6, "tasks": ["5.3", "7.1"] },
    { "id": 7, "tasks": ["7.2", "8.1"] },
    { "id": 8, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 9, "tasks": ["8.5", "8.6"] }
  ]
}
```
