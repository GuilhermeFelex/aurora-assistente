# Configurando a Aurora

Tudo o que define quem a Aurora é fica nesta pasta. São arquivos de texto comuns:
abra no Bloco de Notas, no VS Code ou no Cursor, edite e salve.

| Arquivo | O que define | Quando vale |
|---|---|---|
| `perfil.json` | Nomes, como ela te chama, palavras de ativação, modelo, voz, memória | Reinicie a Aurora |
| `personalidade.md` | Quem ela é, o tom, o tamanho das respostas, o que nunca fazer | Recarregue a página (F5) |
| `regras.md` | Regras extras suas ("sempre em reais", "prefira fontes brasileiras") | F5 |
| `conhecimento/*.md` | Coisas que ela deve saber sobre você, seu trabalho, seus projetos | F5 |
| `memoria.json` | O que ela mesma decidiu guardar nas conversas (criado automaticamente) | F5 |

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

  "modelo": {
    "nome": "claude-sonnet-5",                 // "claude-opus-5" = mais inteligente, porém mais lento
    "esforco": "medium"                        // low | medium | high — quanto ela pensa antes de responder
  },

  "voz": {
    "preferidas": ["Maria", "Francisca", ...], // vozes do Windows/Chrome em ordem de preferência
    "elevenlabsVoiceId": "EXAVITQu4vr4xnSDxMaL" // voz usada se você tiver chave da ElevenLabs
  },

  "memoria": { "ativa": true, "limite": 200 }  // liga/desliga a memória e quantos itens guardar
}
```

Ela nunca acorda com "a aurora", "da aurora" ou "aurora boreal", para não ser
ativada por engano numa conversa normal.

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

Tudo fica em `memoria.json`, que você pode abrir e editar à mão.

## Voz melhor (opcional)

Crie um arquivo chamado `.env` na pasta principal do projeto (ao lado do
`package.json`) com:

```
ELEVENLABS_API_KEY=sua-chave-aqui
```

Com a chave (o plano gratuito da ElevenLabs serve), ela passa a usar uma voz muito
mais natural e um reconhecimento de fala bem mais preciso. Esse arquivo nunca vai
para o GitHub.
