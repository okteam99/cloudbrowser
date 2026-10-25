import net from 'node:net';
// Minimal RFC 1928/1929 test upstream: validates auth and relays CONNECT.
export function socksFixture(onConnect: () => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0),
      stage = 0;
    const parse = (part: Buffer) => {
      pending = Buffer.concat([pending, part]);
      if (stage === 0) {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        pending = pending.subarray(2 + pending[1]);
        socket.write(Buffer.from([5, 2]));
        stage = 1;
      }
      if (stage === 1) {
        if (pending.length < 2) return;
        const ulen = pending[1];
        if (pending.length < 3 + ulen) return;
        const plen = pending[2 + ulen];
        if (pending.length < 3 + ulen + plen) return;
        const valid =
          pending.subarray(2, 2 + ulen).toString() === 'user' &&
          pending.subarray(3 + ulen, 3 + ulen + plen).toString() === 'pass';
        socket.write(Buffer.from([1, valid ? 0 : 1]));
        if (!valid) {
          socket.end();
          return;
        }
        pending = pending.subarray(3 + ulen + plen);
        stage = 2;
      }
      if (stage === 2) {
        if (pending.length < 5) return;
        let host: string, end: number;
        if (pending[3] === 1) {
          if (pending.length < 10) return;
          host = Array.from(pending.subarray(4, 8)).join('.');
          end = 8;
        } else if (pending[3] === 4) {
          if (pending.length < 22) return;
          host = Array.from({ length: 8 }, (_, n) =>
            pending.readUInt16BE(4 + n * 2).toString(16),
          ).join(':');
          end = 20;
        } else if (pending[3] === 3) {
          if (pending.length < 7 + pending[4]) return;
          host = pending.subarray(5, 5 + pending[4]).toString();
          end = 5 + pending[4];
        } else {
          socket.destroy();
          return;
        }
        const port = pending.readUInt16BE(end);
        const rest = pending.subarray(end + 2);
        stage = 3;
        socket.off('data', parse);
        socket.pause();
        onConnect();
        const upstream = net.connect(port, host, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          socket.pipe(upstream).pipe(socket);
          socket.resume();
        });
        sockets.add(upstream);
        upstream.on('error', () => socket.destroy());
        upstream.on('close', () => {
          sockets.delete(upstream);
          socket.destroy();
        });
        socket.on('close', () => upstream.destroy());
      }
    };
    socket.on('data', parse);
  });
  return {
    server,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}
