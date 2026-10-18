# report-web：多阶段镜像 —— Node 构建前端，最终只保留 Nginx + 静态产物（实施文档 §7）
# Node 阶段
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
# 只允许 npm ci（严格按 lockfile 安装）：任何依赖漂移/锁文件缺失都让构建
# 失败显性化，不做 npm install 静默兜底，保证可重现构建（第三方审查 M6）。
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# 运行阶段：只含 Nginx 与静态文件，不运行 Node 服务
FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY security_headers.conf /etc/nginx/security_headers.conf

# 入口认证已移至 Cloudflare Access（One-time PIN 邮件验证码），
# 本容器不再生成/使用 htpasswd，也无需 REPORT_AUTH_USER / REPORT_AUTH_PASSWORD。
CMD ["/bin/sh", "-c", \
  "if [ -z \"${BRIDGE_INTERNAL_TOKEN}\" ]; then echo 'BRIDGE_INTERNAL_TOKEN is required' >&2; exit 1; fi \
   && envsubst '${BRIDGE_INTERNAL_TOKEN}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf \
   && exec nginx -g 'daemon off;'"]

EXPOSE 8080
