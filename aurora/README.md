# Configurando a Aurora

Tudo o que define quem a Aurora é fica nesta pasta. São arquivos de texto comuns:
abra no Bloco de Notas, no VS Code ou no Cursor, edite e salve.

| Arquivo | O que define | Quando vale |
|---|---|---|
| `perfil.json` | Nomes, como ela te chama, palavras de ativação, motor, modelo, voz, memória | Reinicie a Aurora |
| `personalidade.md` | Quem ela é, o tom, o tamanho das respostas, o que nunca fazer | Recarregue a página (F5) |
| `regras.md` | Regras extras suas ("sempre em reais", "prefira fontes brasileiras") | F5 |
| `conhecimento/*.md` | Coisas que ela deve saber sobre você, seu trabalho, seus projetos | F5 |
| Memória | O que ela mesma decidiu guardar nas conversas: fica na nota `07_IA_E_AGENTES/AURORA/memoria-da-aurora.md` do brain-aurora (ou em `memoria.json`, sem o cofre) | F5 |

> **Privacidade:** o repositório no GitHub é público. Arquivos que terminam em
> `.privado.md` (por exemplo `conhecimento/sobre-mim.privado.md`), o `memoria.json`
> e o `.env` **nunca** são enviados ao GitHub — ficam só no seu computador.

## perfil.json

```jsonc
{
  "assistente": { "nome": "Aurora" },          // nome dela (aparece na tela e nas falas)

  "usuario": {
    "nome": "Felex",                           // seu nome
    "tratamento": "senhor Felex",              // como ela te chama nas respostas
    "tratamentoCurto": "senhor",               // forma curta, usada nas falas rápidas ("Sim, senhor?")
    "cidade": "São Paulo",                     // para clima, horários, notícias locais
    "fusoHorario": "America/Sao_Paulo"
  },

  "ativacao": {
    "nomes": ["aurora", "arora", ...],         // como o reconhecimento de voz pode escrever o nome dela
    "saudacoes": ["ei", "oi", "olá", ...],     // o que pode vir antes do nome
    "exigirSaudacao": false                    // true = só acorda com "ei aurora", nunca só "aurora"
  },

  "motor": "claude",                          // "claude" (Claude Code) ou "codex" (ChatGPT) — veja abaixo
  "codex": { "modelo": "", "esforco": "medium" }, // só vale com o motor codex; modelo vazio = o padrão do Codex

  "modelo": {
    "nome": "claude-sonnet-5",                 // "claude-opus-5" = mais inteligente, porém mais lento
    "esforco": "medium"                        // low | medium | high — quanto ela pensa antes de responder
  },

  "voz": {
    "preferidas": ["Maria", "Francisca", ...], // vozes do Windows/Chrome em ordem de preferência
    "elevenlabsVoiceId": "EXAVITQu4vr4xnSDxMaL" // voz usada se você tiver chave da ElevenLabs
  },

  "memoria": {
    "ativa": true, "limite": 200,              // liga/desliga a memória e quantos itens guardar
    "local": "brain",                          // "brain" = guarda numa nota do cofre; "local" = aurora/memoria.json
    "notaBrain": "07_IA_E_AGENTES/AURORA/memoria-da-aurora.md"
  },

  "conversa": { "retomarMinutos": 60 },       // retoma a conversa após recarregar/reiniciar, se for desse tempo; 0 = nunca

  "brain": {
    "ativo": true,                             // integração com o seu cofre do Obsidian
    "pasta": "~/brain-aurora",                 // ~ = sua pasta de usuário (assim o nome de usuário não vai para o GitHub)
    "escrita": "inbox"                         // "inbox" = pode criar notas novas na 90_INBOX; "nao" = só leitura
  },

  "permissoes": {
    "permitir": [],                            // ferramentas liberadas mesmo no modo somente leitura
    "bloquear": []                             // ferramentas sempre proibidas (vence o "permitir")
  }
}
```

Ela nunca acorda com "a aurora", "da aurora" ou "aurora boreal", para não ser
ativada por engano numa conversa normal.

### Permissões

Cada regra é o nome de uma integração ou um padrão com `*`:

- `"spotify"` — todas as ferramentas da integração spotify
- `"mcp__agenda__criar*"` — só as ferramentas que começam com "criar"
- `"Bash"` — uma ferramenta interna pelo nome

Exemplo: `"permitir": ["spotify"], "bloquear": ["mcp__spotify__apagar*"]` deixa ela
tocar música mesmo no modo somente leitura, mas nunca apagar playlists.

## Motor: Claude ou ChatGPT (Codex)

A Aurora pode pensar com dois "cérebros", os dois **sem chave de API** — cada um usa
o login que você já tem no computador:

| `"motor"` | Usa | Login |
|---|---|---|
| `"claude"` (padrão) | Claude Code | sua conta do Claude |
| `"codex"` | Codex (ChatGPT) | sua conta do ChatGPT — rode `codex` no terminal uma vez para entrar |

Para trocar: mude `"motor"` no `perfil.json` e reinicie com `Iniciar Aurora.bat`.
Tudo continua igual — voz, personalidade, memória, brain-aurora, painéis, câmera.
Diferenças com o Codex:

- A resposta chega inteira de uma vez, então ela começa a falar um pouco depois.
- As integrações extras dele vêm do `~/.codex/config.toml` (as do Claude, do `~/.claude.json`).
- O contador de uso mostra tokens, não custo (o ChatGPT não informa valor por conversa).
- Por segurança ele roda em modo somente leitura, a não ser que a Aurora seja iniciada com `--writes`.

## brain-aurora (Obsidian)

Com o cofre encontrado, ela ganha quatro ferramentas:

- **buscar** — procura nas notas (sem ligar para acentos), ignorando templates e arquivo morto
- **ler** — lê uma nota inteira ou só uma seção
- **listar** — mostra as notas de uma área
- **capturar** — cria uma nota nova na `90_INBOX`, no modelo do cofre, marcada como
  `precisa-validacao`. Nunca edita nem apaga notas existentes, e recusa conteúdo que
  pareça senha, token ou chave.

Ela também não faz commit no repositório do cofre: as notas novas ficam para você revisar.

## Iniciar sem janela e com o Windows

- `Iniciar Aurora (sem janela).bat` — liga em segundo plano e abre o Chrome quando estiver pronta.
- `Parar Aurora.bat` — desliga.
- `Ativar inicio com o Windows.bat` / `Desativar inicio com o Windows.bat` — liga ou desliga
  a Aurora automaticamente quando você entra no Windows (sem janela).
- O que ela imprimiria na tela fica em `aurora/aurora.log`.

## personalidade.md e regras.md

Texto livre em português. Escreva como se estivesse explicando a uma pessoa como
ela deve se comportar. Os trechos `{{usuario.tratamento}}`, `{{assistente.nome}}`
etc. são trocados pelos valores do `perfil.json`. Blocos entre `<!--` e `-->` são
comentários e são ignorados.

## conhecimento/

Cada arquivo `.md` aqui vira conhecimento dela. Bons exemplos:

- `sobre-mim.privado.md` — quem você é, aniversário, família, gostos
- `trabalho.privado.md` — empresa, cargo, projetos, colegas
- `casa.md` — rotina, endereços de lugares que você frequenta

Mantenha curto e objetivo: tudo isso é enviado a cada conversa.

## Memória

Ela guarda sozinha fatos duradouros que você conta ("prefiro café sem açúcar") e
você pode pedir:

- "Aurora, lembra que meu aniversário é dia 12 de março."
- "Aurora, o que você lembra sobre mim?"
- "Aurora, esquece o que eu falei sobre o café."

Com o brain-aurora conectado, tudo fica na nota **Memória da Aurora**
(`07_IA_E_AGENTES/AURORA/memoria-da-aurora.md`), que você pode abrir e editar no
Obsidian: uma linha por fato, no formato `- texto (AAAA-MM-DD) ^m12`. Linhas que
você escrever sem o `^m` ganham um número sozinhas. Sem o cofre, ela usa
`aurora/memoria.json`. Na primeira vez, o que estava no `memoria.json` é movido
para a nota (o arquivo antigo fica guardado como `memoria.migrada.json`).

## Conhecimento sob demanda

Um arquivo de `conhecimento/` que tenha a marca `<!-- sob-demanda -->` não vai em
toda conversa: ela só vê o nome e o assunto, e abre o conteúdo (ferramenta
`consultar`) quando a pergunta precisar. Use para material longo de referência,
como o `sobre-a-aurora.md`. Arquivos na pasta `conhecimento/consulta/` funcionam
do mesmo jeito.

## Formato TOON

Listas que ela recebe das ferramentas (resultados de busca no brain, notas de
uma área, memórias, material de consulta) vêm no formato
[TOON](https://github.com/toon-format/spec): os campos aparecem uma vez e cada
item ocupa uma linha, o que gasta bem menos tokens que JSON.

## Voz melhor (opcional)

Crie um arquivo chamado `.env` na pasta principal do projeto (ao lado do
`package.json`) com:

```
ELEVENLABS_API_KEY=sua-chave-aqui
```

Com a chave (o plano gratuito da ElevenLabs serve), ela passa a usar uma voz muito
mais natural e um reconhecimento de fala bem mais preciso. Esse arquivo nunca vai
para o GitHub.
