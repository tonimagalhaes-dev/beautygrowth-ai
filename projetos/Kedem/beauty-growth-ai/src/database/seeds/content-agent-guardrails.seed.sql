-- =============================================================================
-- Seed: Content Agent — Guardrails padrão do sistema
-- Descrição: Insere guardrails regulatórios obrigatórios para o Content Agent.
--            Estes são guardrails de sistema (tenant_id = NULL) aplicados a
--            todas as gerações de conteúdo, independentemente do tenant.
-- Requisitos: 4.1 (Validação de Guardrails)
-- =============================================================================

-- Guardrail 1: Proibição de promessas de resultados específicos de tratamentos
INSERT INTO guardrails (id, tenant_id, type, name, description, rule, version, is_active)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-100000000001',
  NULL,
  'system',
  'no_result_promises',
  'Proíbe promessas de resultados específicos de tratamentos estéticos ou médicos. Conteúdo não pode garantir outcomes, percentuais de eficácia absolutos ou eliminação completa de condições.',
  '{
    "pattern": "(garant[ei](mos)?\\s+(o\\s+)?resultado|resultado\\s+garantido|100%\\s+(eficaz|eficácia|efetivo|de\\s+sucesso)|cura\\s+definitiva|elimina(r)?\\s+completamente|resultado\\s+imediato|sem\\s+(nenhum\\s+)?risco|resultado\\s+permanente|sucesso\\s+absoluto|garantia\\s+de\\s+(resultado|cura|melhora))",
    "keywords": [
      "garante resultado",
      "resultado garantido",
      "100% eficaz",
      "cura definitiva",
      "elimina completamente",
      "resultado imediato",
      "sem risco",
      "resultado permanente",
      "sucesso absoluto",
      "garantia de resultado"
    ],
    "categories": ["compliance", "anvisa", "publicidade_medica"],
    "action": "regenerate",
    "maxRetries": 3,
    "severity": "high",
    "message": "Conteúdo contém promessa de resultado proibida por regulamentação ANVISA/CFM. Regenerando sem garantias absolutas."
  }',
  1,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Guardrail 2: Proibição de diagnósticos médicos
INSERT INTO guardrails (id, tenant_id, type, name, description, rule, version, is_active)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-100000000002',
  NULL,
  'system',
  'no_medical_diagnosis',
  'Proíbe linguagem que configure diagnóstico médico. O Content Agent não pode sugerir que o paciente possui determinada condição, doença ou patologia.',
  '{
    "pattern": "(voc[êe]\\s+(tem|possui|sofre\\s+de|apresenta|está\\s+com)|sua\\s+condi[çc][ãa]o\\s+(é|indica)|isso\\s+(é|indica|sugere)\\s+(um[a]?\\s+)?(doen[çc]a|patologia|condi[çc][ãa]o)|indicativo\\s+de\\s+doen[çc]a|diagn[óo]stico\\s+(é|seria|indica)|sintomas\\s+indicam\\s+que\\s+voc[êe])",
    "keywords": [
      "diagnóstico",
      "você tem",
      "você sofre de",
      "sua condição é",
      "indicativo de doença",
      "você apresenta",
      "sintomas indicam",
      "isso é uma doença",
      "patologia identificada"
    ],
    "categories": ["compliance", "cfm", "exercicio_ilegal_medicina"],
    "action": "regenerate",
    "maxRetries": 3,
    "severity": "critical",
    "message": "Conteúdo contém linguagem de diagnóstico médico, proibida para agentes de marketing. Regenerando sem linguagem diagnóstica."
  }',
  1,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Guardrail 3: Proibição de prescrições de medicamentos ou tratamentos
INSERT INTO guardrails (id, tenant_id, type, name, description, rule, version, is_active)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-100000000003',
  NULL,
  'system',
  'no_prescriptions',
  'Proíbe prescrição de medicamentos, dosagens ou tratamentos específicos. O Content Agent não pode recomendar uso de fármacos, suplementos com dosagem ou protocolos de tratamento.',
  '{
    "pattern": "(prescrevo|tome\\s+\\d|use\\s+o\\s+medicamento|receita\\s+de|dosagem\\s+de|\\d+\\s*(mg|ml|comprimidos|gotas|c[áa]psulas)|apli(que|car)\\s+\\d|injetar\\s+\\d|fa[çc]a\\s+uso\\s+de|recomendo\\s+(o\\s+)?(medicamento|rem[ée]dio|f[áa]rmaco)|protocolo\\s+de\\s+\\d+\\s*(sess[õo]es|dias|semanas))",
    "keywords": [
      "prescrevo",
      "tome",
      "use o medicamento",
      "receita de",
      "dosagem",
      "faça uso de",
      "aplique",
      "recomendo o medicamento",
      "protocolo de tratamento"
    ],
    "categories": ["compliance", "cfm", "anvisa", "prescricao_ilegal"],
    "action": "regenerate",
    "maxRetries": 3,
    "severity": "critical",
    "message": "Conteúdo contém linguagem prescritiva de medicamentos ou tratamentos, proibida por regulamentação. Regenerando sem prescrições."
  }',
  1,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Guardrail 4: Proibição de alegações de saúde não autorizadas (ANVISA/CFM)
INSERT INTO guardrails (id, tenant_id, type, name, description, rule, version, is_active)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-100000000004',
  NULL,
  'system',
  'no_unauthorized_health_claims',
  'Proíbe alegações de saúde não autorizadas pela ANVISA ou CFM. Inclui claims de cura, tratamentos milagrosos, superioridade não comprovada e referências falsas a aprovações regulatórias.',
  '{
    "pattern": "(aprovado\\s+pela\\s+ANVISA\\s+para|clinicamente\\s+comprovado\\s+que\\s+cura|tratamento\\s+milagroso|cura\\s+milagros[ao]|[úu]nico\\s+(tratamento|procedimento|m[ée]todo)\\s+que|revolucion[áa]rio\\s+que\\s+(cura|elimina|resolve)|cientificamente\\s+comprovado\\s+que\\s+(cura|elimina)|m[ée]dicos\\s+(recomendam|confirmam)\\s+que\\s+(cura|elimina)|sem\\s+efeitos?\\s+colaterais|zero\\s+efeitos?\\s+(adversos|colaterais)|substitui\\s+(cirurgia|medicamento|tratamento\\s+m[ée]dico))",
    "keywords": [
      "aprovado pela ANVISA para",
      "clinicamente comprovado que cura",
      "tratamento milagroso",
      "cura milagrosa",
      "único tratamento que",
      "revolucionário que cura",
      "cientificamente comprovado que cura",
      "sem efeitos colaterais",
      "zero efeitos adversos",
      "substitui cirurgia"
    ],
    "categories": ["compliance", "anvisa", "cfm", "propaganda_enganosa"],
    "action": "regenerate",
    "maxRetries": 3,
    "severity": "high",
    "message": "Conteúdo contém alegações de saúde não autorizadas por ANVISA/CFM. Regenerando sem claims regulatórios não comprovados."
  }',
  1,
  TRUE
)
ON CONFLICT (id) DO NOTHING;
