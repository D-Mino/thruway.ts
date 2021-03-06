import { WampErrorException } from "../Common/WampErrorException";
import { ResultMessage } from "../Messages/ResultMessage";
import { CancelMessage } from "../Messages/CancelMessage";
import { ErrorMessage } from "../Messages/ErrorMessage";
import { CallMessage } from "../Messages/CallMessage";
import { IMessage } from "../Messages/Message";
import { Utils } from "../Common/Utils";
import {
  Observable,
  Subject,
  Scheduler,
  Subscriber,
  Subscription,
  from,
  of,
} from "rxjs";
import {
  filter,
  finalize,
  flatMap,
  map,
  merge,
  publish,
  refCount,
  share,
  take,
  takeUntil,
  takeWhile,
  tap,
} from "rxjs/operators";

export interface CallOptions {
  receive_progress?: boolean;
  timeout?: number;
  disclose_me?: boolean;

  [propName: string]: any;
}

export class CallObservable<ResultMsg> extends Observable<any> {
  private completed = false;
  private messages: Observable<IMessage>;

  constructor(
    private uri: string,
    messages: Observable<IMessage>,
    private webSocket: Subject<any>,
    private args?: Array<any>,
    private argskw?: Object,
    private options: CallOptions = {},
    private scheduler?: Scheduler
  ) {
    super();
    this.messages = messages.pipe(share());
  }

  public _subscribe(
    subscriber: Subscriber<any>
  ): Subscription | Function | void {
    const requestId = Utils.uniqueId();
    const callMsg = new CallMessage(
      requestId,
      this.options,
      this.uri,
      this.args,
      this.argskw
    );

    const msg = this.messages.pipe(
      tap(null, () => (this.completed = true)),
      filter(
        (m: any) => m instanceof ResultMessage && m.requestId === requestId
      ),
      filter(
        (m: ResultMessage) => !!m.args || !!m.argskw || !m.details.progress
      ),
      flatMap((m: ResultMessage, index: number) => {
        // If there is no progress and it's the first message or there are no args, add a fake progress to
        // the end so that the observable completes
        if (
          !!m.details.progress === false &&
          (index === 0 || m.args || m.argskw)
        ) {
          const details = m.details;

          details.progress = true;

          return from(
            [
              new ResultMessage(m.requestId, details, m.args, m.argskw),
              new ResultMessage(m.requestId, { progress: false }),
            ],
            this.scheduler as Scheduler
          );
        }

        return of(m);
      }),
      publish(),
      refCount()
    );

    // take until we get a message with progress: false
    const resultMsg = msg.pipe(
      takeWhile((m) => m.details.progress || false),
      finalize(() => (this.completed = true)),
      share()
    );

    const error = this.messages.pipe(
      filter(
        (m: any) =>
          m instanceof ErrorMessage && m.errorRequestId === requestId
      ),
      map((errMsg: ErrorMessage) => {
        errMsg.args.push({ uri: this.uri });
        return errMsg;
      }),
      tap(() => (this.completed = true)),
      takeUntil(msg.pipe(filter((m) => !m.details.progress))),
      flatMap((m: ErrorMessage) =>
        Observable.throw(
          new WampErrorException(m.errorURI, m.args),
          this.scheduler
        )
      ),
      take(1)
    );

    try {
      this.webSocket.next(callMsg);
    } catch (e) {
      subscriber.error(e);
      return;
    }

    const result: Observable<ResultMessage> = error.pipe(
      merge(resultMsg),
      map((m: ResultMessage) => {
        const details = m.details;
        delete details.progress;
        return new ResultMessage(m.requestId, details, m.args, m.argskw);
      })
    );

    const disposable = new Subscription(() => {
      if (!this.completed) {
        const cancelMsg = new CancelMessage(requestId, {});
        this.webSocket.next(cancelMsg);
      }
    });

    disposable.add(
      result.subscribe(
        (v) => subscriber.next(v),
        (e) => subscriber.error(e),
        () => subscriber.complete()
      )
    );

    return disposable;
  }
}
