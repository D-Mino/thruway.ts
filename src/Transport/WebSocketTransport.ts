import { CreateMessage } from '../Messages/CreateMessage';
import { OpenMessage } from '../Messages/OpenMessage';
import { Subject, Subscriber, Subscription, fromEvent, timer, of } from 'rxjs';
import * as WebSocketType from 'ws';

import {
  catchError,
  delay,
  startWith,
  switchMapTo,
  takeUntil,
  tap,
} from 'rxjs/operators';

export class WebSocketTransport<M> extends Subject<M> {
  private output: Subject<any> = new Subject();
  private socket?: WebSocketType;
  private resetKeepaliveSubject = new Subject();
  private keepAliveTimer = 30000;

  constructor(
    private url: string = 'ws://127.0.0.1:9090/',
    private protocols: string | string[] = ['wamp.2.json'],
    private autoOpen: boolean = true
  ) {
    super();
  }

  public _subscribe(subscriber: Subscriber<any>): Subscription {
    this.output = new Subject();

    const subscription = new Subscription();

    if (this.autoOpen) {
      this.connectSocket();
    }

    subscription.add(this.output.subscribe(subscriber));

    subscription.add(() => {
      setTimeout(() => {
        if (this.socket) {
          console.log('closing socket');
          this.socket.close();
          this.socket = undefined;
        }
      }, 100);
    });

    return subscription;
  }

  private connectSocket(): void {
    if (this.socket) {
      return;
    }

    try {
      if (typeof WebSocket === 'undefined') {
        throw new Error("Websocket not supported");
      }

      let ws: any = new WebSocket(this.url, this.protocols);

      this.socket = ws;

      ws.onerror = (err: Error) => {
        this.resetKeepaliveSubject.next(0);
        this.socket = undefined;
        this.output.error(err);
      };

      ws.onclose = (e: CloseEvent) => {
        this.resetKeepaliveSubject.next(0);
        this.socket = undefined;

        // Handle all closes as errors
        const ex = new Error(e.reason || 'The WebSocket connection was closed');
        this.output.error(ex);
      };

      ws.onopen = (e: Event) => {
        console.log('WebSocket connection has opened');
        this.output.next(new OpenMessage({ event: e }));
      };

      ws.onmessage = (e: MessageEvent) => {
        this.output.next(CreateMessage.fromArray(JSON.parse(e.data)));
      };
    } catch (ex) {
      this.output.error(ex);
    }
  }

  private keepAlive(ws: WebSocketType) {
    this.resetKeepaliveSubject.next(0);

    fromEvent(ws, 'pong')
      .pipe(
        startWith(0),
        switchMapTo(
          timer(this.keepAliveTimer).pipe(
            tap(() => ws.ping()),
            delay(20000)
          )
        ),
        takeUntil(this.resetKeepaliveSubject),
        catchError((e) => {
          console.log(e.message);
          return of();
        })
      )
      .subscribe(() => {
        console.log(
          'Terminating because we have not received a pong back from the server'
        );
        ws.terminate();
      });
  }

  public next(msg: any): void {
    // @todo should queue up messages here

    if (this.socket && this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(msg.wampifiedMsg()));
    }
  }

  public unsubscribe(): void {
    super.unsubscribe();

    if (this.socket) {
      this.socket.close();
    }
  }

  public open() {
    this.connectSocket();
    this.autoOpen = true;
  }
}
