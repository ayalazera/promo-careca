# Promo Autônomo

Plataforma local para:

1. Buscar promoções (modo demo ou afiliados Amazon/ML)
2. Montar posts por categoria (eletrônicos, games, TCG, etc.)
3. Publicar em grupos do WhatsApp via sessão **não oficial** (Baileys / WhatsApp Web)
4. Aplicar **regras anti-ban** (limites, delays, aquecimento, horário silencioso)

> **Aviso:** automação não oficial viola os termos do WhatsApp. As regras **reduzem** risco de banimento, **não eliminam**. Use conta secundária e volume conservador.

## Subir

Na raiz do workspace **ou** dentro de `promo-autonomo`:

```bash
# opção A — na raiz /agent
npm run install:app
npm run dev

# opção B — dentro do app
cd promo-autonomo
cp .env.example .env   # se ainda não tiver .env
npm install
npm run seed
npm run dev
```

Depois abra no navegador: **http://localhost:3847**

Se der erro de porta em uso:

```bash
fuser -k 3847/tcp
npm run dev
```

> `npm run dev` **não abre o navegador sozinho** — só sobe o servidor. Você precisa abrir o link acima.

## Fluxo

1. Conecte o WhatsApp
2. Crie o grupo no WhatsApp e, na aba **Grupos**, cole o link de convite + a categoria (ex.: `eletronicos`)
3. O bot entra no grupo e envia só as promoções dessa categoria
4. O scheduler busca ofertas e tenta publicar em ondas pequenas

## Regras anti-ban (padrão)

| Regra | Padrão |
|-------|--------|
| Delay aleatório entre mensagens | 90–240 s |
| Máx. por hora | 8 |
| Máx. por dia | 40 (12 nos 7 primeiros dias) |
| Grupos por onda | 3 |
| Cooldown após onda | 15 min |
| Horário silencioso | 23h–8h |
| Evitar texto idêntico | cooldown 180 min |
| Pausa automática | erros 403/ban-like |

Ajuste no `.env` (`ANTIBAN_*`).

## Contas Amazon / Mercado Livre — como ficam registradas

**Não salvamos login/senha** da conta pessoal. Só credenciais de **programa de afiliados** (API oficial):

| Plataforma | O que registrar | Onde |
|------------|-----------------|------|
| Amazon Associates | `Access Key`, `Secret Key`, `Partner Tag` (PA-API 5) | Painel → cofre AES-256-GCM ou `.env` |
| Mercado Livre | Perfil criador (`/social/usuario`) + link `meli.la` **por produto** | Painel → Contas |

No painel as keys aparecem **mascaradas**. O cofre usa `CREDENTIALS_SECRET`.

### Estratégia anti-ban das APIs (Pulse Reputation + Harvest→Mint)

1. **Só API oficial** — sem scraping logado (maior causa de ban de afiliado)
2. **Harvest → Mint** — busca produto via API; o link `?tag=` / `matt_tool` é montado **localmente**
3. **Cache longo** (2–3h) — mesma busca não bate na API de novo
4. **1 query por ciclo** — sem rajada de searches
5. **Pulse heat** — erros/429 aumentam “calor”; orçamento horário encolhe sozinho
6. **Circuit breaker** — 429/falhas seguidas pausam o provedor dezenas de minutos
7. **Jitter** — espera variável entre chamadas

> Isso protege a **conta de afiliado/API**. O anti-ban do WhatsApp é camada separada.

Defina `CREDENTIALS_SECRET` no `.env`, desligue `DEMO_MODE` e salve as keys no painel.

## Posts estilo canal + cupom + marca d'água

Antes de publicar no WhatsApp:

1. Cupons ML entram como `hold_coupon`
2. O sistema **testa o cupom** (preço antes/depois)
3. Só posta se o cupom estiver `valid` (ou se não houver cupom)
4. Monta texto no formato do anexo (`De` / `Por` / cupom / link)
5. Baixa a imagem, aplica **marca d'água** (handle + tagline + "agora") e envia

## Séries de grupos (link único)

Crie uma série com o nome que quiser (ex.: `Rei das promoções`).

- 1º grupo: **Rei das promoções**
- Se encher: cria **Rei das promoções 2**, depois **3**…
- Link público estável: `http://localhost:3847/r/seu-slug`

## Mercado Livre — automação dos GANHOS EXTRAS

O Hub ([afiliados/hub](https://www.mercadolivre.com.br/afiliados/hub?is_affiliate=true)) **não tem API pública**.
Para ler comissão e gerar `meli.la` no seu nome, a ferramenta usa a **sessão do navegador**:

1. Hub logado → F12 → Rede → `createLink` / `createUrls`
2. Copie `Cookie`, `x-csrf-token` e a `tag` (etiqueta)
3. Contas → Salvar sessão Hub
4. Promoções → **Sync Hub (maiores ganhos)**

A ferramenta ordena por % de GANHOS EXTRAS, gera os links e enfileira no WhatsApp.
Cookies expiram — quando o sync falhar, atualize Cookie/CSRF.

| Campo | Onde | Serve para |
|-------|------|------------|
| Cookie + CSRF + tag | F12 no Hub | Automação real |
| Perfil `/social/usuario` | ocarafmz | Rótulo |
| Colar JSON da Rede | Avançado | Se a listagem automática não achar o endpoint |

## Limites honestos

- Não escala para milhares de grupos com segurança
- Conta WhatsApp pode ser banida mesmo com regras
- Prefira poucos grupos engajados e intervalos longos
