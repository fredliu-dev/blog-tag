# Blog Tag 插件配置说明

## config.json

`extension/config.json` 是插件的核心配置文件，所有可调整项都集中在这里。

### keywords

用于拦截页面请求的匹配关键词。只要请求 URL 中包含其中任意一个关键词，就会被插件捕获并记录。

| 关键词 | 说明 |
|--------|------|
| `admin.shopify.com/api/operations` | Shopify 后台操作 API 的基础路径 |
| `ArticleList` | 文章列表接口，匹配 ID 流程用它来获取文章 ID |
| `ArticleDetailsUpdate` | 文章详情更新接口，打标签流程通过它确认标签保存成功 |

### listening

是否启用页面接口拦截。保持 `true` 即可。

### defaultChangeType

CSV 中没有“修改类型”列时，自动填充的默认值。

- `"替换"`：会用表格里的标签替换页面上的标签，页面上多余的标签会被删除
- `"新增"`：只把表格里有、但页面上没有的标签添加进去，不删除已有标签

### selectors

页面元素选择器配置。如果 Shopify 后台页面结构变化，只需要改这里的选择器，不需要改代码。

| 配置项 | 说明 |
|--------|------|
| `nextPageButton` | 匹配 ID 时翻页按钮的容器，取按钮组中的第二个 |
| `saveButton` | 文章编辑页的保存按钮，点击后会触发 `ArticleDetailsUpdate` 接口 |
| `tagRemoveButton` | 标签删除按钮主选择器 |
| `tagRemoveButtonFallback` | 标签删除按钮兜底选择器 1 |
| `tagRemoveButtonFallback2` | 标签删除按钮兜底选择器 2 |
| `tagText` | 标签文本元素，用于读取页面上已有的标签名称 |
| `tagWrapper` | 标签外层容器，用于根据删除按钮定位标签文本 |
| `tagInput` | 添加新标签时的输入框 |
| `tagDropdownOption` | 输入标签后自动补全下拉列表中的选项 |

## 修改配置后

修改 `config.json` 后，需要重新加载插件扩展才能生效。
