# Claude connections / Claude 接入

The Claude row manages **Claude Code CLI** and the **Code area in Claude Desktop** through one local route. The regular Claude Desktop chat interface is a separate product path. / Claude 栏通过同一本地路由管理 CLI 和 Desktop 的 Code 区域；Desktop 普通聊天界面属于另一条产品链路。

Add a Claude subscription through official login, or add an Anthropic Messages-compatible API. Importing a current setup uses only the available local credentials. / 可通过官方认证添加订阅，或添加兼容 Anthropic Messages 的 API；导入当前配置只使用本地可读凭据。

## Third-party models / 第三方模型

A model listing does not guarantee tool use or subagent compatibility. If the client exposes Claude families but the API provides another model, open **Edit provider → Model mapping** and choose the upstream ID for each family. Main and subagent mappings are independent. / 模型目录不代表工具调用与子代理一定兼容；若客户端显示 Claude 系列而上游提供其他模型，在服务商编辑中设置系列映射，主模型与子代理可分别指定。

Mappings preserve tools and message history; the provider still needs to implement the request protocol. Reload Claude after initial setup or model-menu changes. / 映射保留工具与历史，但上游仍需正确实现协议；首次配置或修改模型菜单后重新加载 Claude。
