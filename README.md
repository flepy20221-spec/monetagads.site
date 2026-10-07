# Young Money — Mini App no Telegram

O site estático em `index.html` usa a zona Monetag `11977205` para anúncios recompensados e mostra um progresso visual de até 15 vídeos por dia. Ele é publicado em `https://flepy20221-spec.github.io/monetagads.site/`.

O progresso fica no armazenamento local do navegador e **não é saldo, pontos nem comprovante de pagamento**. Cada tentativa de anúncio recebe um `ymid` único de um servidor que valida o `initData` do Telegram. Impressões confirmadas pela Monetag são contadas separadamente; uma impressão indica o início da exibição e pode ser não monetizada.

## Bot

O código do webhook de `@YoungMoneyOFC_bot` está em [`bot/`](bot/). Para implantá-lo no Railway, use este repositório com o diretório raiz `/bot`, um volume persistente montado em `/data` e as variáveis privadas `BOT_TOKEN`, `WEBHOOK_SECRET`, `MONETAG_POSTBACK_SECRET`, `WEBAPP_URL` e `DATA_DIR=/data`. O serviço atende `GET /health` e `POST /telegram/webhook`; a segunda rota aceita apenas requisições com o cabeçalho secreto configurado em `setWebhook` no Telegram. Nunca adicione tokens ao repositório.

O site pede `POST /api/ad-attempts` com o `Telegram.WebApp.initData` assinado, passa o `ymid` retornado para `show_11977205({type:"end", ymid, requestVar:"daily_video"})` e pode consultar `GET /api/impressions` com o mesmo cabeçalho. O bot expõe `/status` para as contagens do próprio usuário. O servidor armazena tentativas, impressões e cliques num registro append-only no volume, responde a postbacks duplicados sem somar novamente e mantém os cliques fora da contagem de impressões.

Após uma tentativa de anúncio, o botão mostra uma contagem regressiva de 10 segundos antes de permitir a próxima. A Mini App também espera 10 segundos após o anúncio fechar ou falhar. O servidor aplica um intervalo mínimo de 10 segundos entre tentativas do mesmo ID do Telegram, mesmo após recarregar a página ou reiniciar o serviço; durante esse intervalo, retorna HTTP 429 com `retryAfterSeconds`.

Na zona SDK `11977205` da Monetag, o campo de postback deve ter uma URL HTTPS com os macros `{ymid}`, `{event_type}`, `{reward_event_type}`, `{zone_id}`, `{sub_zone_id}`, `{estimated_price}`, `{request_var}` e `{telegram_id}`, além de um parâmetro `key` com o valor privado de `MONETAG_POSTBACK_SECRET`. O endpoint é `GET /monetag/postback`. Só aceite o segredo em variáveis privadas e nas configurações da Monetag, nunca no código. Respostas 503 são repetidas pela Monetag; respostas 200 para duplicatas não geram uma segunda impressão. Não conceda créditos nem saques sem uma regra de negócio e conciliação próprias.

O painel administrativo consulta `GET /admin/monetag` no serviço do bot com `Authorization: Bearer` e o segredo privado `MONETAG_ADMIN_SECRET`. Opcionalmente, `telegram_id` seleciona um usuário, e `limit` restringe o histórico dos anúncios a 1–100. O relatório junta impressão e clique pelo `ymid` e soma apenas preços de eventos `valued` como **estimativa em USD**; não representa saldo final da Monetag nem saldo do usuário. Configure no servidor do painel `MONETAG_BOT_REPORT_URL` com a URL HTTPS do bot e `MONETAG_BOT_REPORT_SECRET` com o mesmo segredo, mantendo ambos fora do navegador e do Git.

A [política de privacidade](privacy.html) da Mini App fica na mesma hospedagem estática. O botão de menu, os comandos e os textos do perfil do bot são configurados na API do Telegram. O destaque **Main Mini App** e o link da política no perfil são opções do `@BotFather` gerenciadas pelo dono do bot.
