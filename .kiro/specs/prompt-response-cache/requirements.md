# Requirements Document

## Introduction

The Prompt/Response Cache feature enables users to consult and reuse previously generated content (text and images) without consuming AI tokens. Users can browse a history panel listing past generations for their clinic, reload cached results instantly on exact prompt matches, receive confirmation prompts for similar matches, and initiate refinements from any cached entry using the existing refine flow.

## Glossary

- **Cache_System**: The backend subsystem responsible for storing, matching, and retrieving previously generated prompt/response pairs as TypeORM entities in PostgreSQL.
- **History_Panel**: A frontend sidebar/panel component that displays a browsable list of past generations scoped to the authenticated clinic (tenant).
- **Prompt_Fingerprint**: A normalized hash derived from the GenerateBriefingDto fields (tema, procedimento, publicoAlvoOverride, redesSociais, idioma) used for exact-match cache lookups.
- **Cache_Entry**: A persisted record containing the original prompt parameters, the generated text response, associated image references, creation timestamp, and tenant scope.
- **Refinement_Overlay**: The existing UI overlay component (RefinementOverlay) that allows users to submit refinement instructions against a loaded execution.
- **Content_Agent**: The NestJS service that generates social media content based on a briefing.
- **Designer_Agent**: The NestJS service that generates images from content executions.
- **Tenant**: The clinic context under which all data is scoped, identified by tenantId.
- **Exact_Match**: A cache lookup where the Prompt_Fingerprint of the submitted prompt is identical to a stored Cache_Entry fingerprint within the same Tenant.
- **Similar_Match**: A cache lookup where the submitted prompt shares high similarity with a stored Cache_Entry but is not an Exact_Match.

## Requirements

### Requirement 1: Cache Entry Persistence

**User Story:** As a clinic user, I want my generated content to be automatically saved so that I can reuse it later without regenerating.

#### Acceptance Criteria

1. WHEN the Content_Agent successfully generates a response with status "draft", THE Cache_System SHALL persist a Cache_Entry containing the prompt parameters, Prompt_Fingerprint, generated response payload, and Tenant identifier.
2. WHEN the Designer_Agent completes image generation for a content execution, THE Cache_System SHALL associate the generated image references with the corresponding Cache_Entry.
3. THE Cache_System SHALL store each Cache_Entry as a TypeORM entity in the existing PostgreSQL database.
4. THE Cache_System SHALL scope every Cache_Entry to the originating Tenant so that entries from one clinic are not accessible by another clinic.

### Requirement 2: Exact Match Auto-Return

**User Story:** As a clinic user, I want to receive an instant cached response when I submit an identical prompt so that I do not consume AI tokens unnecessarily.

#### Acceptance Criteria

1. WHEN a user submits a generation request, THE Cache_System SHALL compute a Prompt_Fingerprint from the normalized prompt parameters (tema, procedimento, publicoAlvoOverride, redesSociais, idioma).
2. WHEN an Exact_Match exists for the computed Prompt_Fingerprint within the same Tenant, THE Cache_System SHALL return the cached response without invoking the Content_Agent.
3. WHEN a cached response is returned via Exact_Match, THE Cache_System SHALL include a flag indicating the response originated from cache.
4. WHEN a cached response is returned via Exact_Match, THE Cache_System SHALL report zero tokens consumed for the request.

### Requirement 3: Similar Match Confirmation

**User Story:** As a clinic user, I want to be shown a similar cached result and asked for confirmation before reusing it so that I can decide whether to use the cached version or generate fresh content.

#### Acceptance Criteria

1. WHEN a user submits a generation request that has no Exact_Match but has a Similar_Match within the same Tenant, THE Cache_System SHALL return the similar cached response together with a confirmation flag.
2. WHEN the frontend receives a response with a confirmation flag, THE History_Panel SHALL display the cached result and prompt the user to confirm reuse or proceed with a new generation.
3. WHEN the user confirms reuse of a Similar_Match, THE Cache_System SHALL return the cached response without invoking the Content_Agent.
4. WHEN the user declines reuse of a Similar_Match, THE Cache_System SHALL proceed with a new generation request to the Content_Agent.

### Requirement 4: History Panel Browsing

**User Story:** As a clinic user, I want to browse all my past generations in a dedicated panel so that I can find and reload any previous result.

#### Acceptance Criteria

1. THE History_Panel SHALL display a chronologically ordered list of Cache_Entries scoped to the authenticated Tenant.
2. THE History_Panel SHALL display for each Cache_Entry: the original tema, the redesSociais used, the creation timestamp, and a preview of the generated content.
3. WHEN the user selects a Cache_Entry from the History_Panel, THE History_Panel SHALL load the full cached response (text and image references) into the result view.
4. THE History_Panel SHALL fetch Cache_Entries using paginated queries via TanStack Query to avoid loading all records at once.
5. WHEN no Cache_Entries exist for the authenticated Tenant, THE History_Panel SHALL display an empty state message indicating no previous generations are available.

### Requirement 5: Refinement from Cached Entry

**User Story:** As a clinic user, I want to refine a cached result using the existing refine flow so that I can iterate on previous content without starting from scratch.

#### Acceptance Criteria

1. WHEN a user selects a Cache_Entry and initiates refinement, THE History_Panel SHALL open the Refinement_Overlay pre-loaded with the cached execution context.
2. WHEN a refinement is submitted from a cached entry, THE Content_Agent SHALL process the refinement request using the original executionId and count the refinement against the execution's 5-refinement limit.
3. WHEN a refinement is submitted from a cached entry, THE Content_Agent SHALL consume AI tokens only for the refinement generation.
4. THE History_Panel SHALL NOT pre-fill the briefing form fields when loading a cached entry for refinement.

### Requirement 6: Cache Scoping and Data Isolation

**User Story:** As a clinic administrator, I want cache data to be strictly isolated per clinic so that one clinic cannot access another clinic's generated content.

#### Acceptance Criteria

1. THE Cache_System SHALL include the Tenant identifier as a mandatory filter in every cache query operation.
2. THE Cache_System SHALL enforce tenant scoping at the database query level so that no cross-tenant data leakage is possible.
3. WHEN a cache lookup is performed, THE Cache_System SHALL match entries only within the requesting Tenant's scope.

### Requirement 7: Cache Response Metadata

**User Story:** As a clinic user, I want to clearly see whether a response came from cache or was freshly generated so that I understand my token consumption.

#### Acceptance Criteria

1. WHEN the Cache_System returns a cached response, THE Cache_System SHALL include metadata indicating the response source as "cache".
2. WHEN the Content_Agent generates a fresh response, THE Cache_System SHALL include metadata indicating the response source as "generated".
3. THE frontend SHALL display a visual indicator differentiating cached responses from freshly generated responses.
