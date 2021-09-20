import { Subject, Subscriber, Subscription } from "rxjs";
import { filter } from "rxjs/operators";
import { CreateMessage } from "../Messages/CreateMessage";
import { OpenMessage } from "../Messages/OpenMessage";

export class WebWorkerTransport<Message> extends Subject<any> {
  private output: Subject<any> = new Subject();
  private worker?: Worker;

  constructor(
    private workerName: string = "worker.js",
    private url: string = "ws://127.0.0.1:9090/",
    private protocols: string | string[] = ["wamp.2.json"]
  ) {
    super();
  }

  public _subscribe(subscriber: Subscriber<any>): Subscription {
    let ww: Worker = new Worker(this.workerName);

    this.output = new Subject();

    const messages = new Subject();

    ww.postMessage({ type: "open", url: this.url, protocols: this.protocols });
    ww.onmessage = (e) => {
      messages.next(e);
    };

    const open = messages
      .pipe(filter((e: any) => e.data.type === "open"))
      .subscribe((e: Event) => {
        console.log("socket opened");
        this.worker = ww;
        this.output.next(new OpenMessage({ event: e }));
      });

    const close = messages
      .pipe(filter((e: any) => e.data.type === "close"))
      .subscribe((e) => {
        this.worker = undefined;

        // Handle all closes as errors
        this.output.error(e);
      });

    const message = messages
      .pipe(filter((e: any) => e.data.type === "message"))
      .subscribe((e: any) => {
        console.log(e.data.payload);
        const d = e.data.payload;
        this.output.next(CreateMessage.fromArray(d));
      });

    const error = messages
      .pipe(filter((e: any) => e.data.type === "error"))
      .subscribe((e) => {
        this.worker = undefined;
        this.output.error(e);
      });

    const subscription = new Subscription();

    subscription.add(this.output.subscribe(subscriber));
    subscription.add(error);
    subscription.add(message);
    subscription.add(close);
    subscription.add(open);

    subscription.add(() => {
      if (this.worker) {
        console.log("closing socket");
        this.worker.postMessage({ type: "close" });
        this.worker = undefined;
      }
    });

    return subscription;
  }

  public next(msg: any): void {
    if (!this.worker) {
      return;
    }

    this.worker.postMessage({ type: "send", payload: msg.wampifiedMsg() });
  }

  public unsubscribe(): void {
    super.unsubscribe();

    if (this.worker) {
      this.worker.postMessage({ type: "close" });
    }
  }
}
