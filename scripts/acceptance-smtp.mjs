import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

const smtpPort = Number(process.env.E2E_SMTP_PORT ?? 2525);
const mailboxPort = Number(process.env.E2E_MAILBOX_PORT ?? 2526);
const messages = [];

function attachment(raw) {
  const match = raw.match(/Content-Type: application\/pdf[^\r\n]*[\s\S]*?Content-Transfer-Encoding: base64[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/i);
  return match ? Buffer.from(match[1].replace(/\s/g, ""), "base64").toString("base64") : null;
}

const smtp = createTcpServer((socket) => {
  socket.setEncoding("utf8");
  socket.write("220 localhost E2E SMTP ready\r\n");
  let pending = "";
  let dataMode = false;
  let lines = [];
  let recipient = "";
  socket.on("data", (chunk) => {
    pending += chunk;
    while (pending.includes("\r\n")) {
      const end = pending.indexOf("\r\n");
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      if (dataMode) {
        if (line === ".") {
          const raw = lines.join("\r\n");
          messages.push({ recipient, pdfBase64: attachment(raw) });
          lines = [];
          dataMode = false;
          socket.write("250 Message accepted\r\n");
        } else {
          lines.push(line.startsWith("..") ? line.slice(1) : line);
        }
      } else if (/^EHLO\b/i.test(line)) {
        socket.write("250-localhost\r\n250 SIZE 10485760\r\n");
      } else if (/^HELO\b|^MAIL FROM:|^RSET\b|^NOOP\b/i.test(line)) {
        socket.write("250 OK\r\n");
      } else if (/^RCPT TO:/i.test(line)) {
        recipient = line.slice(8).trim().replace(/[<>]/g, "");
        socket.write("250 OK\r\n");
      } else if (/^DATA\b/i.test(line)) {
        dataMode = true;
        socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      } else if (/^QUIT\b/i.test(line)) {
        socket.end("221 Goodbye\r\n");
      } else {
        socket.write("502 Command not supported\r\n");
      }
    }
  });
});

const mailbox = createHttpServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/messages") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(messages));
});

smtp.listen(smtpPort, "127.0.0.1");
mailbox.listen(mailboxPort, "127.0.0.1");
process.on("SIGTERM", () => { smtp.close(); mailbox.close(); });
