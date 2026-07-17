# Design Document: Prompt/Response Cache

## Overview

This feature introduces a persistent prompt/response cache layer that intercepts the content generation flow to avoid redundant AI token consumption. When a user submits a prompt identical (or similar) to a previously generated one, the system returns the cached result instantly. A History Panel on the frontend provides browsable access to all past generations.

The design integrates with the existing `ContentAgentService` generate flow, the `DesignerAgentService` image generation, and leverages the project's TypeORM + PostgreSQL infrastructure for persistence with tenant-scoped Row-Level Security.

---

## Architecture

### High-Level Flow

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────────┐
│  Frontend   │────▶│  ContentAgent     │────▶│  PromptCache      │
│  (React)    │◀────│  Controller       │◀────│  Service           │
└─────────────┘     └──────────────────┘     └───────────────────┘
                                                       │
                                              ┌────────┴────────┐
                                              │  PostgreSQL      │
                                              │  prompt_cache    │
                                              │  _entries table  │
                                              └─────────────────┘
```

1. User submits `GenerateBriefingDto` via frontend
2. `PromptCacheService` computes fingerprint and checks for exact/similar match
3. On exact match → return cached response with `source: "cache"`
4. On similar match → return cached response with `confirmationRequired: true`
5. On no match → delegate to `ContentAgentService.generate()`, persist result
6. After `DesignerAgent` completes, associate image references with cache entry

### Module Structure

```
src/modules/prompt-cache/
├── prompt-cache.module.ts
├── entities/
│   └── prompt-cache-entry.entity.ts
├── services/
│   ├── prompt-cache.service.ts
│   └── prompt-fingerprint.service.ts
├── controllers/
│   └── prompt-cache.controller.ts
├── dto/
│   ├── cache-lookup-response.dto.ts
│   ├── confirm-similar-match.dto.ts
│   └── cache-entry-list.dto.ts
├── interfaces/
│   └── prompt-cache.interface.ts
└── tests/
    ├── prompt-cache.service.spec.ts
    └── prompt-fingerprint.service.spec.ts
```

---

## Data Models

### PromptCacheEntry Entity

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { RedeSocial } from '@/modules/content-agent/dto/generate-briefing.dto';

@Entity('prompt_cache_entries')
@Index(['tenantId', 'fingerprint'], { unique: true })
@Index(['tenantId', 'createdAt'])
export class PromptCacheEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'execution_id', type: 'uuid' })
  executionId: string;

  // --- Prompt Parameters (original input) ---

  @Column({ name: 'tema', type: 'text' })
  tema: string;

  @Column({ name: 'procedimento', type: 'uuid', nullable: true })
  procedimento: string | null;

  @Column({ name: 'publico_alvo_override', type: 'varchar', length: 300, nullable: true })
  publicoAlvoOverride: string | null;

  @Column({ name: 'redes_sociais', type: 'text', array: true })
  redesSociais: RedeSocial[];

  @Column({ name: 'idioma', type: 'varchar', length: 10, default: 'pt-BR' })
  idioma: string;

  // --- Fingerprint ---

  @Column({ name: 'fingerprint', type: 'varchar', length: 64 })
  fingerprint: string;

  @Column({ name: 'normalized_tema', type: 'text' })
  normalizedTema: string;

  // --- Cached Response ---

  @Column({ name: 'response_payload', type: 'jsonb' })
  responsePayload: Record<string, any>;

  @Column({ name: 'image_references', type: 'jsonb', default: '[]' })
  imageReferences: Array<{ imageId: string; url: string; redeSocial: string }>;

  // --- Metadata ---

  @Column({ name: 'tokens_consumed_input', type: 'int', default: 0 })
  tokensConsumedInput: number;

  @Column({ name: 'tokens_consumed_output', type: 'int', default: 0 })
  tokensConsumedOutput: number;

  @Column({ name: 'modelo_utilizado', type: 'varchar', length: 255 })
  modeloUtilizado: string;

  @Column({ name: 'hit_count', type: 'int', default: 0 })
  hitCount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
```

### Database Migration

```sql
CREATE TABLE prompt_cache_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  execution_id UUID NOT NULL,
  tema TEXT NOT NULL,
  procedimento UUID,
  publico_alvo_override VARCHAR(300),
  redes_sociais TEXT[] NOT NULL,
  idioma VARCHAR(10) NOT NULL DEFAULT 'pt-BR',
  fingerprint VARCHAR(64) NOT NULL,
  normalized_tema TEXT NOT NULL,
  response_payload JSONB NOT NULL,
  image_references JSONB NOT NULL DEFAULT '[]',
  tokens_consumed_input INT NOT NULL DEFAULT 0,
  tokens_consumed_output INT NOT NULL DEFAULT 0,
  modelo_utilizado VARCHAR(255) NOT NULL,
  hit_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique index for exact match lookups (tenant-scoped)
CREATE UNIQUE INDEX idx_prompt_cache_tenant_fingerprint
  ON prompt_cache_entries (tenant_id, fingerprint);

-- Index for chronological listing per tenant
CREATE INDEX idx_prompt_cache_tenant_created
  ON prompt_cache_entries (tenant_id, created_at DESC);

-- RLS policy for tenant isolation
ALTER TABLE prompt_cache_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY prompt_cache_tenant_isolation ON prompt_cache_entries
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

---

## Prompt Fingerprinting Algorithm

### Normalization Steps

The fingerprint is computed deterministically from the prompt parameters through normalization:

```typescript
@Injectable()
export class PromptFingerprintService {
  /**
   * Computes a SHA-256 fingerprint from normalized prompt parameters.
   * Normalization ensures that semantically equivalent prompts
   * produce the same hash regardless of formatting differences.
   */
  computeFingerprint(params: FingerprintInput): string {
    const normalized = this.normalize(params);
    const payload = JSON.stringify(normalized);
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Normalizes prompt parameters for consistent hashing:
   * 1. tema: lowercase, trim, collapse whitespace
   * 2. procedimento: lowercase or null
   * 3. publicoAlvoOverride: lowercase, trim, collapse whitespace or null
   * 4. redesSociais: sorted alphabetically
   * 5. idioma: lowercase
   */
  normalize(params: FingerprintInput): NormalizedFingerprint {
    return {
      tema: this.normalizeText(params.tema),
      procedimento: params.procedimento?.toLowerCase() ?? null,
      publicoAlvoOverride: params.publicoAlvoOverride
        ? this.normalizeText(params.publicoAlvoOverride)
        : null,
      redesSociais: [...params.redesSociais].sort(),
      idioma: (params.idioma ?? 'pt-BR').toLowerCase(),
    };
  }

  /**
   * Returns the normalized tema text for similar match comparison.
   */
  getNormalizedTema(tema: string): string {
    return this.normalizeText(tema);
  }

  private normalizeText(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  }
}

interface FingerprintInput {
  tema: string;
  procedimento?: string;
  publicoAlvoOverride?: string;
  redesSociais: string[];
  idioma?: string;
}

interface NormalizedFingerprint {
  tema: string;
  procedimento: string | null;
  publicoAlvoOverride: string | null;
  redesSociais: string[];
  idioma: string;
}
```

### Design Rationale

- **SHA-256**: Produces a 64-character hex string, collision-resistant, fast to compute
- **Sorted redesSociais**: `['instagram', 'facebook']` and `['facebook', 'instagram']` produce the same fingerprint
- **Collapsed whitespace**: Prevents trivial formatting differences from creating new entries
- **Lowercase normalization**: Case-insensitive matching for user convenience

---

## Similar Match Detection

### Approach: PostgreSQL `pg_trgm` Trigram Similarity

For similar match detection, we use PostgreSQL's `pg_trgm` extension to find entries where the `normalized_tema` is similar to the submitted prompt's normalized tema, scoped to the same tenant and matching other parameters.

```sql
-- Enable trigram extension (one-time migration)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN index for trigram similarity searches
CREATE INDEX idx_prompt_cache_tema_trgm
  ON prompt_cache_entries USING gin (normalized_tema gin_trgm_ops);
```

### Similar Match Query

```typescript
async findSimilarMatch(
  tenantId: string,
  normalizedTema: string,
  redesSociais: string[],
  idioma: string,
  procedimento: string | null,
  threshold: number = 0.6,
): Promise<PromptCacheEntry | null> {
  const result = await this.repository
    .createQueryBuilder('cache')
    .where('cache.tenant_id = :tenantId', { tenantId })
    .andWhere('cache.redes_sociais = :redesSociais', {
      redesSociais: redesSociais.sort(),
    })
    .andWhere('cache.idioma = :idioma', { idioma })
    .andWhere(
      procedimento
        ? 'cache.procedimento = :procedimento'
        : 'cache.procedimento IS NULL',
      { procedimento },
    )
    .andWhere('similarity(cache.normalized_tema, :tema) > :threshold', {
      tema: normalizedTema,
      threshold,
    })
    .orderBy('similarity(cache.normalized_tema, :tema)', 'DESC')
    .limit(1)
    .getOne();

  return result;
}
```

### Similarity Threshold

- **0.6** (configurable via environment variable `PROMPT_CACHE_SIMILARITY_THRESHOLD`)
- Entries that match on `redesSociais`, `idioma`, and `procedimento` exactly, and have tema similarity > threshold qualify as similar matches
- The highest-similarity entry is returned

---

## Components and Interfaces

### Backend Services

| Component | Responsibility |
|-----------|---------------|
| `PromptCacheModule` | NestJS module registering all cache-related providers |
| `PromptCacheService` | Core service: cache lookup, persistence, similar match detection |
| `PromptFingerprintService` | Normalization + SHA-256 fingerprint computation |
| `PromptCacheController` | REST API for history panel and similar match confirmation |

### Frontend Components

| Component | Responsibility |
|-----------|---------------|
| `HistoryPanel` | Side panel listing past generations with pagination |
| `CacheEntryCard` | Individual cache entry preview card |
| `SimilarMatchConfirmation` | Dialog for user to confirm/decline similar match reuse |
| `CacheSourceBadge` | Visual indicator for cache vs generated responses |
| `usePromptCache` | TanStack Query hook for cache operations |

### Key Interfaces

```typescript
export interface CacheLookupResult {
  type: 'exact_match' | 'similar_match' | 'miss';
  entry?: PromptCacheEntry;
  source?: 'cache' | 'generated';
  tokensConsumed?: { input: number; output: number };
  confirmationRequired?: boolean;
}

export interface PaginatedCacheEntries {
  data: CacheEntryPreview[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface CacheEntryPreview {
  id: string;
  tema: string;
  redesSociais: string[];
  createdAt: string;
  contentPreview: string;
  hasImages: boolean;
}

export interface CacheEntryDetailResponse {
  id: string;
  executionId: string;
  tema: string;
  procedimento: string | null;
  publicoAlvoOverride: string | null;
  redesSociais: string[];
  idioma: string;
  responsePayload: ContentAgentResponse;
  imageReferences: Array<{ imageId: string; url: string; redeSocial: string }>;
  createdAt: string;
}

export interface ConfirmSimilarMatchDto {
  cacheEntryId: string;
  confirmed: boolean;
}

export interface ContentAgentResponseWithMeta extends ContentAgentResponse {
  source: 'cache' | 'generated';
  confirmationRequired?: boolean;
  cacheEntryId?: string;
}
```

---

## Backend API Endpoints

### PromptCacheController

```typescript
@Controller('prompt-cache')
@UseGuards(TenantGuard)
export class PromptCacheController {
  constructor(private readonly promptCacheService: PromptCacheService) {}

  /**
   * GET /api/prompt-cache/entries
   * Returns paginated list of cache entries for the tenant.
   * Query params: page (default 1), limit (default 20)
   */
  @Get('entries')
  async listEntries(
    @CurrentTenant() tenant: TenantContext,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<PaginatedCacheEntries> { ... }

  /**
   * GET /api/prompt-cache/entries/:id
   * Returns full cache entry details including response payload.
   */
  @Get('entries/:id')
  async getEntry(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CacheEntryDetailResponse> { ... }

  /**
   * POST /api/prompt-cache/confirm-similar
   * User confirms or declines use of a similar match.
   * Body: { cacheEntryId: string, confirmed: boolean }
   */
  @Post('confirm-similar')
  @HttpCode(HttpStatus.OK)
  async confirmSimilarMatch(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: ConfirmSimilarMatchDto,
  ): Promise<ContentAgentResponseWithMeta> { ... }
}
```

### Integration with ContentAgent Generate Flow

The cache check is integrated as an interceptor in the generate flow:

```typescript
// In PromptCacheService
async checkCacheOrGenerate(
  dto: GenerateBriefingDto,
  tenantId: string,
  userId: string,
): Promise<CacheLookupResult> {
  const fingerprint = this.fingerprintService.computeFingerprint(dto);
  const normalizedTema = this.fingerprintService.getNormalizedTema(dto.tema);

  // 1. Check exact match
  const exactMatch = await this.repository.findOne({
    where: { tenantId, fingerprint },
  });

  if (exactMatch) {
    await this.repository.increment({ id: exactMatch.id }, 'hitCount', 1);
    return {
      type: 'exact_match',
      entry: exactMatch,
      source: 'cache',
      tokensConsumed: { input: 0, output: 0 },
    };
  }

  // 2. Check similar match
  const similarMatch = await this.findSimilarMatch(
    tenantId,
    normalizedTema,
    dto.redesSociais,
    dto.idioma ?? 'pt-BR',
    dto.procedimento ?? null,
  );

  if (similarMatch) {
    return {
      type: 'similar_match',
      entry: similarMatch,
      source: 'cache',
      confirmationRequired: true,
    };
  }

  // 3. No match — proceed with generation
  return { type: 'miss' };
}
```

### Modified ContentAgent Generate Response

```typescript
export interface ContentAgentResponseWithMeta extends ContentAgentResponse {
  source: 'cache' | 'generated';
  confirmationRequired?: boolean;
  cacheEntryId?: string;
}
```

### Persisting Cache Entry After Generation

```typescript
// Called after successful ContentAgentService.generate()
async persistCacheEntry(
  dto: GenerateBriefingDto,
  response: ContentAgentResponse,
  tenantId: string,
  userId: string,
): Promise<PromptCacheEntry> {
  const fingerprint = this.fingerprintService.computeFingerprint(dto);
  const normalizedTema = this.fingerprintService.getNormalizedTema(dto.tema);

  const entry = this.repository.create({
    tenantId,
    userId,
    executionId: response.executionId,
    tema: dto.tema,
    procedimento: dto.procedimento ?? null,
    publicoAlvoOverride: dto.publicoAlvoOverride ?? null,
    redesSociais: dto.redesSociais,
    idioma: dto.idioma ?? 'pt-BR',
    fingerprint,
    normalizedTema,
    responsePayload: response as unknown as Record<string, any>,
    tokensConsumedInput: response.tokensConsumidos.input,
    tokensConsumedOutput: response.tokensConsumidos.output,
    modeloUtilizado: response.modeloUtilizado,
  });

  return this.repository.save(entry);
}
```

### Associating Image References

```typescript
// Called after DesignerAgent completes for a content execution
async associateImages(
  executionId: string,
  tenantId: string,
  images: Array<{ imageId: string; url: string; redeSocial: string }>,
): Promise<void> {
  await this.repository.update(
    { executionId, tenantId },
    { imageReferences: images },
  );
}
```

---

## Frontend Design

### HistoryPanel Component

```typescript
// frontend/src/components/HistoryPanel.tsx
interface HistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectEntry: (entry: CacheEntryPreview) => void;
  onRefineEntry: (entry: CacheEntryPreview) => void;
}
```

The `HistoryPanel` renders as a `Sheet` (side panel) matching the existing `RefinementOverlay` pattern:

- **Header**: Title "Histórico de Gerações" with close button
- **List**: Scrollable, paginated list of `CacheEntryCard` items
- **Empty State**: Message when no entries exist
- **Pagination**: "Load more" button at bottom using infinite scroll pattern via TanStack Query's `useInfiniteQuery`

### CacheEntryCard Component

```typescript
interface CacheEntryCardProps {
  entry: CacheEntryPreview;
  onSelect: () => void;
  onRefine: () => void;
}
```

Displays:
- `tema` (truncated to 80 chars)
- `redesSociais` as badge chips
- `createdAt` formatted as relative time
- Content preview (first 120 chars of first legenda)
- "Usar" and "Refinar" action buttons

### SimilarMatchConfirmation Component

```typescript
interface SimilarMatchConfirmationProps {
  entry: CacheEntryPreview;
  similarity: number;
  onConfirm: () => void;
  onDecline: () => void;
}
```

Renders as a `Dialog` when `confirmationRequired` is true in the generate response:
- Shows the similar cached result preview
- "Usar resultado anterior" (confirm) button
- "Gerar novo conteúdo" (decline) button

### CacheSourceBadge Component

```typescript
interface CacheSourceBadgeProps {
  source: 'cache' | 'generated';
}
```

A small badge rendered in `ResultPanel` showing:
- 🟢 "Cache" — green badge for cached responses
- 🔵 "Gerado" — blue badge for fresh generations

### usePromptCache Hook

```typescript
export function usePromptCache() {
  const entries = useInfiniteQuery({
    queryKey: ['prompt-cache', 'entries'],
    queryFn: ({ pageParam = 1 }) =>
      promptCacheService.listEntries({ page: pageParam, limit: 20 }),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.page + 1 : undefined,
  });

  const confirmSimilar = useMutation({
    mutationFn: (data: { cacheEntryId: string; confirmed: boolean }) =>
      promptCacheService.confirmSimilarMatch(data),
  });

  const getEntry = useMutation({
    mutationFn: (id: string) => promptCacheService.getEntry(id),
  });

  return { entries, confirmSimilar, getEntry };
}
```

### Integration with Existing Generate Flow

The `useContentAgent` hook's `generate` mutation is modified to handle the new response shape:

```typescript
// In useContentAgent.ts - onSuccess handler
onSuccess: (result) => {
  if (result.confirmationRequired && result.cacheEntryId) {
    // Show SimilarMatchConfirmation dialog
    setSimilarMatch(result);
  } else {
    setCurrentResult(result);
  }
}
```

---

## Tenant Isolation Approach

1. **Entity-level**: Every `PromptCacheEntry` has a mandatory `tenantId` column
2. **Query-level**: All repository queries include `WHERE tenant_id = :tenantId`
3. **RLS-level**: PostgreSQL Row-Level Security policy enforces isolation at database layer using `app.current_tenant_id` session variable
4. **Guard-level**: `TenantGuard` extracts tenant from JWT and sets the PostgreSQL session variable before queries execute
5. **Index-level**: The unique fingerprint index is compound `(tenant_id, fingerprint)`, preventing cross-tenant collision

This triple-layer approach (application query + RLS + guard) ensures defense-in-depth against data leakage.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| PostgreSQL unavailable for cache read | Log warning, skip cache, proceed with generation |
| PostgreSQL unavailable for cache write | Log error, return generated response (cache miss is non-blocking) |
| Fingerprint computation fails | Log error, proceed with generation (treat as miss) |
| Similar match query times out | Log warning, proceed with generation |
| Cache entry not found for confirm | Return 404 with descriptive message |
| Invalid pagination params | Return 400 with validation errors |
| Cross-tenant access attempt | RLS blocks silently, returns empty result |

The cache layer is **non-blocking** — failures in cache read/write never prevent content generation from completing.

---

## Testing Strategy

### Unit Tests (Jest + fast-check)
- `PromptFingerprintService`: determinism, normalization rules, edge cases (empty strings, unicode)
- `PromptCacheService`: exact match logic, similar match logic, tenant filtering, pagination
- Property-based tests using `fast-check` for fingerprint and cache round-trip properties

### Integration Tests
- Cache entry persistence after content generation (full flow with DB)
- Image reference association after designer-agent completion
- Tenant isolation verified with multi-tenant scenarios
- Similar match detection with `pg_trgm` on real PostgreSQL

### Frontend Tests (Vitest + React Testing Library)
- `HistoryPanel`: renders entries, empty state, pagination
- `SimilarMatchConfirmation`: confirm/decline behavior
- `CacheSourceBadge`: correct visual for each source type
- `usePromptCache`: hook behavior with mocked API responses

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Fingerprint Determinism

For any valid `GenerateBriefingDto` parameters, computing the fingerprint multiple times with the same input SHALL always produce the same SHA-256 hash value.

**Validates: Requirements 2.1**

### Property 2: Cache Round-Trip

For any valid `GenerateBriefingDto` and tenant, if a generation produces a "draft" response and is persisted as a cache entry, then a subsequent lookup with the same prompt parameters and tenant SHALL return the exact same response payload.

**Validates: Requirements 1.1, 2.2**

### Property 3: Tenant Isolation

For any two distinct tenant identifiers and any cache entry created by one tenant, querying the cache with the other tenant's identifier SHALL never return that entry.

**Validates: Requirements 1.4, 6.1, 6.2, 6.3**

### Property 4: Source Metadata Correctness

For any cache lookup, if the result is a cache hit (exact or confirmed similar match), the response source SHALL be "cache" and tokensConsumed SHALL be `{ input: 0, output: 0 }`. If the result is a fresh generation (cache miss or declined similar match), the response source SHALL be "generated".

**Validates: Requirements 2.3, 2.4, 7.1, 7.2**

### Property 5: Similar Match Subsumption

For any prompt that produces an exact match, it SHALL never be classified as a similar match. Exact match detection takes strict priority over similar match detection.

**Validates: Requirements 2.2, 3.1**

### Property 6: Chronological Ordering Invariant

For any paginated query of cache entries for a given tenant, the returned list SHALL be ordered by `createdAt` descending, such that for any two adjacent entries `entries[i]` and `entries[i+1]`, `entries[i].createdAt >= entries[i+1].createdAt`.

**Validates: Requirements 4.1**

### Property 7: Pagination Bounds

For any tenant with N cache entries and a page size of L, requesting page P SHALL return at most L entries, and the total number of entries across all pages SHALL equal N.

**Validates: Requirements 4.4**
