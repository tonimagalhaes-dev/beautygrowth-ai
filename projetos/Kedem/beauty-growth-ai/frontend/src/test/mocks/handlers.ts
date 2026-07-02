import { http, HttpResponse } from 'msw'

import type { ContentAgentResult } from '@/types/content-agent'
import type { LoginResponse } from '@/types/auth'

const API_BASE_URL = 'http://localhost:3000'

export const mockLoginResponse: LoginResponse = {
  accessToken: 'fake-jwt-token',
  refreshToken: 'fake-refresh-token',
}

export const mockGenerateResult: ContentAgentResult = {
  executionId: 'exec-123',
  status: 'draft',
  version: 1,
  legendas: {
    instagram:
      '✨ Descubra o poder da harmonização facial! Resultados naturais que realçam sua beleza única. Agende sua avaliação. #harmonizacao #estetica',
    facebook:
      'Você merece se sentir bem consigo mesma! Conheça nossos tratamentos de harmonização facial com resultados naturais e seguros. Entre em contato para agendar sua avaliação gratuita.',
    tiktok:
      'POV: você acabou de fazer harmonização facial e ficou INCRÍVEL 🔥 #harmonizacao #antesedepois #estetica',
  },
  hashtags: [
    '#harmonizacaofacial',
    '#estetica',
    '#belezanatural',
    '#clinicadeestetica',
    '#procedimentoestetico',
    '#beautygrowth',
  ],
  sugestoesVisuais: {
    instagram: {
      formato: '4:5',
      descricao:
        "Foto antes/depois com iluminação profissional, fundo neutro e marca d'água sutil no canto inferior direito.",
    },
    facebook: {
      formato: '1.91:1',
      descricao:
        'Banner horizontal com foto do procedimento à esquerda e texto com benefícios à direita, usando paleta de cores da marca.',
    },
    tiktok: {
      formato: '9:16',
      descricao:
        'Vídeo vertical com transição antes/depois, texto overlay animado e música trending.',
    },
  },
  modeloUtilizado: 'gpt-4o-mini',
  usouFallback: false,
  tokensConsumidos: { input: 1250, output: 890 },
  duracaoMs: 3200,
}

export const mockRefineResult: ContentAgentResult = {
  ...mockGenerateResult,
  version: 2,
  legendas: {
    instagram:
      '✨ Harmonização facial com técnicas avançadas! Realce sua beleza de forma natural e segura. Agende agora! #harmonizacao #beleza',
    facebook:
      'Transforme sua autoestima com nossos tratamentos de harmonização facial! Técnicas modernas, resultados naturais. Agende sua consulta hoje mesmo.',
    tiktok:
      'Glow up real com harmonização facial 💫 Resultado natural que todo mundo elogia! #glowup #harmonizacao #estetica',
  },
}

export const handlers = [
  // Auth - Login
  http.post(`${API_BASE_URL}/api/auth/login`, () => {
    return HttpResponse.json(mockLoginResponse)
  }),

  // Clinics - Create
  http.post(`${API_BASE_URL}/api/clinics`, () => {
    return HttpResponse.json({ id: 'clinic-1' }, { status: 201 })
  }),

  // Brands - Create
  http.post(`${API_BASE_URL}/api/brands`, () => {
    return HttpResponse.json({ id: 'brand-1' }, { status: 201 })
  }),

  // Clinics - Status
  http.get(`${API_BASE_URL}/api/clinics/me/status`, () => {
    return HttpResponse.json({ clinicSetup: true })
  }),

  // Content Agent - Generate
  http.post(`${API_BASE_URL}/api/content-agent/generate`, () => {
    return HttpResponse.json(mockGenerateResult)
  }),

  // Content Agent - Refine
  http.post(`${API_BASE_URL}/api/content-agent/refine`, () => {
    return HttpResponse.json(mockRefineResult)
  }),
]
