# Young Money — Mini App no Telegram

O site estático em `index.html` usa a zona Monetag `11977205` para anúncios recompensados e mostra um progresso visual de até 15 vídeos por dia. Ele é publicado em `https://flepy20221-spec.github.io/monetagads.site/`.

O progresso fica no armazenamento local do navegador e **não é saldo, pontos nem comprovante de pagamento**. Para conceder créditos reais seria necessário validar os postbacks da Monetag em um backend confiável, sem confiar apenas no callback do navegador.

## Bot

O código do webhook de `@YoungMoneyOFC_bot` está em [`bot/`](bot/). Para implantá-lo no Railway, use este repositório com o diretório raiz `/bot` e configure as variáveis privadas `BOT_TOKEN`, `WEBHOOK_SECRET` e `WEBAPP_URL`. O serviço atende `GET /health` e `POST /telegram/webhook`; a segunda rota aceita apenas requisições com o cabeçalho secreto configurado em `setWebhook` no Telegram. Nunca adicione tokens ao repositório.

A [política de privacidade](privacy.html) da Mini App fica na mesma hospedagem estática. O botão de menu, os comandos e os textos do perfil do bot são configurados na API do Telegram. O destaque **Main Mini App** e o link da política no perfil são opções do `@BotFather` gerenciadas pelo dono do bot.
