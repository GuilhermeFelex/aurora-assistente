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

  "motores": { ... },                         // qual IA responde cada tipo de pedido — veja "Motores" abaixo
  "codex": { ... }, "gemini": { ... }, "llama": { ... }, // opções de cada motor

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

## Motores: qual IA responde cada tipo de pedido

A Aurora usa várias IAs, **nenhuma com chave de API**. Cada uma usa um login que você
já tem no computador, ou roda no próprio PC:

| Motor | O que é | Como entrar |
|---|---|---|
| `claude` | Claude Code | sua conta do Claude (`claude` no terminal) |
| `codex` | ChatGPT, pelo Codex. Também **gera imagens** | sua conta do ChatGPT (`codex` no terminal) |
| `gemini` | Gemini CLI | sua conta do Google (`gemini` no terminal) |
| `llama` | Llama rodando no seu PC, pelo [Ollama](https://ollama.com). Grátis e offline | instale o Ollama e rode `ollama pull llama3.1:8b` |

No `perfil.json`, o bloco `motores` diz quem responde o quê:

```jsonc
"motores": {
  "padrao": "gemini",                  // conversa do dia a dia (quando nenhum tipo se aplica)
  "reserva": "claude",                 // usado quando o motor escolhido não está disponível
  "classificador": "palavras+llama",   // "palavras" = só palavras-chave; "+llama" = o Llama local decide os casos duvidosos (grátis)
  "tipos": {
    "imagem":   { "motor": "codex",  "palavras": ["gera uma imagem", "desenha", ...] },
    "web":      { "motor": "codex",  "palavras": ["pesquis", "notícia", "previsão do tempo", ...] },
    "complexa": { "motor": "claude", "modelo": "claude-opus-5", "palavras": ["analisa", "passo a passo", ...], "minPalavras": 35 },
    "rapida":   { "motor": "llama",  "palavras": ["bom dia", "que horas", ...], "maxPalavras": 8 }
  }
}
```

Como ela decide, do jeito mais barato para o mais caro:

1. **Você manda:** "pergunta pro Gemini…", "usa o ChatGPT…", "pelo Claude…" — vale na hora.
2. **Palavras-chave** de cada tipo, na ordem em que os tipos estão escritos. Sem ligar
   para acentos e maiúsculas, e a palavra pode ser só o começo ("pesquis" pega
   "pesquisa" e "pesquisar"). `maxPalavras` limita o tipo a pedidos curtos.
3. **Tamanho:** `minPalavras` manda pedidos longos para aquele tipo (ex.: complexa).
4. **Classificador local:** com `"palavras+llama"`, o Llama do seu PC lê o pedido e
   escolhe o tipo, usando a `descricao` de cada um. Não gasta nada de nenhuma assinatura.
5. Se nada disso decidir, vai para o `padrao`.

Você pode criar quantos tipos quiser (ex.: `"codigo"`, `"traducao"`), com qualquer motor.
`modelo` e `esforco` num tipo trocam o modelo só para aquele tipo de pedido.

Quando o motor muda no meio da conversa, o novo recebe um resumo das últimas trocas
que ele não viu, então a conversa continua de onde parou. Se o motor escolhido não
estiver instalado, logado ou ligado, a **reserva** responde no lugar, e aquele motor fica
de fora por 5 minutos. No terminal aparece qual motor respondeu cada pedido
(`[aurora] web → ChatGPT (Codex) · por palavra`).

Opções de cada motor:

- `codex`: `modelo`, `esforco`, `imagens` (true = pode gerar imagens; elas aparecem na tela sozinhas)
- `gemini`: `modelo` (vazio = automático), `caminho` (só se o `gemini` não for encontrado sozinho)
- `llama`: `modelo` (o nome no Ollama), `url`, `ferramentas` (memória, cofre e interface), `contexto`
- `claude`: continua no bloco `modelo`

Diferenças práticas: o ChatGPT entrega a resposta inteira de uma vez, então ela começa a
falar um pouco depois. O Llama não acessa a internet. As integrações extras vêm da
configuração de cada programa (`~/.claude.json`, `~/.codex/config.toml`,
`~/.gemini/settings.json`).

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
