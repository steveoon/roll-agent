# browser-use-agent

`browser-use-agent` is a persistent HTTP agent for browser automation.

## Page Context Rules

Split tools into page-context groups:

- Chat tools require the chat page: `https://www.zhipin.com/web/geek/chat`
- Recommend tools require the recommend page: `https://www.zhipin.com/web/chat/recommend`
- Generic tools can run on any page

If a tool returns empty data or cannot find elements, switch page context first with:

```bash
roll run browser-use-agent navigate_active_tab --input-json '{"url":"..."}' --json
```

## candidateName Auto-Navigation

These tools accept `candidateName` and can navigate to the candidate chat automatically:

- `zhipin_get_candidate_info(candidateName?, index?, maxMessages?)`
- `zhipin_send_reply(message, candidateName?, index?)`
- `zhipin_exchange_wechat(candidateName?, index?)`

Do not call `zhipin_open_chat` first unless you need to force a specific chat before another step.

## Tool Groups

### Generic Tools

- `browser_status()`
- `navigate_active_tab(url)`
- `open_platform(platform)`
- `list_pages(platform?)`
- `select_page(platform, pageId)`

### Chat Tools

- `zhipin_read_messages(limit?, onlyUnread?, sortBy?)`
- `zhipin_open_chat(candidateName?, index?, preferUnread?)`
- `zhipin_get_candidate_info(candidateName?, index?, maxMessages?)`
- `zhipin_send_reply(message, candidateName?, index?)`
- `zhipin_exchange_wechat(candidateName?, index?)`
- `zhipin_get_username()`

### Recommend Tools

- `zhipin_get_candidate_list(maxResults?)`
- `zhipin_say_hello(indices)`
- `zhipin_open_resume(index)`
- `zhipin_close_resume()`
- `zhipin_locate_resume_canvas()`
