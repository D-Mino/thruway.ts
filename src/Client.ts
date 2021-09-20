import { WampChallengeException } from './Common/WampChallengeException';
import { WebSocketTransport } from './Transport/WebSocketTransport';
import {
  RegisterObservable,
  RegisterOptions,
} from './Observable/RegisterObservable';
import { AuthenticateMessage } from './Messages/AuthenticateMessage';
import { WampErrorException } from './Common/WampErrorException';
import {
  PublishOptions,
  TopicObservable,
  TopicOptions,
} from './Observable/TopicObservable';
import { ChallengeMessage } from './Messages/ChallengeMessage';
import { CallObservable, CallOptions } from './Observable/CallObservable';
import { GoodbyeMessage } from './Messages/GoodbyeMessage';
import { WelcomeMessage } from './Messages/WelcomeMessage';
import { PublishMessage } from './Messages/PublishMessage';
import { ResultMessage } from './Messages/ResultMessage';
import { RegisteredMessage } from './Messages/RegisteredMessage';
import { UnregisteredMessage } from './Messages/UnregisteredMessage';
import { EventMessage } from './Messages/EventMessage';
import { HelloMessage } from './Messages/HelloMessage';
import { AbortMessage } from './Messages/AbortMessage';
import { OpenMessage } from './Messages/OpenMessage';
import { IMessage } from './Messages/Message';
import { Utils } from './Common/Utils';

import {
  Observable,
  of,
  partition,
  ReplaySubject,
  Subject,
  Subscription,
  throwError,
  timer,
} from 'rxjs';
import {
  catchError,
  combineLatest,
  delay,
  exhaust,
  finalize,
  flatMap,
  map,
  merge,
  mergeMap,
  multicast,
  race,
  refCount,
  retryWhen,
  share,
  shareReplay,
  switchMap,
  switchMapTo,
  take,
  takeUntil,
  tap,
} from 'rxjs/operators';

export class Client {
  private static roles = {
    caller: {
      features: {
        caller_identification: true,
        progressive_call_results: true,
        call_canceling: true,
      },
    },
    callee: {
      features: {
        caller_identification: true,
        pattern_based_registration: true,
        shared_registration: true,
        progressive_call_results: true,
        registration_revocation: true,
        call_canceling: true,
      },
    },
    publisher: {
      features: {
        publisher_identification: true,
        subscriber_blackwhite_listing: true,
        publisher_exclusion: true,
      },
    },
    subscriber: {
      features: {
        publisher_identification: true,
        pattern_based_subscription: true,
        subscription_revocation: true,
      },
    },
  };

  private static retryDefaults: RetryOptions = {
    maxRetryDelay: 60000,
    initialRetryDelay: 1500,
    retryDelayGrowth: 1.5,
    maxRetries: 10000,
  };

  private subscription: Subscription = new Subscription();
  private _onClose: Subject<IMessage> = new Subject();
  private _onError: Subject<Error> = new Subject();
  private _session: Observable<SessionData>;
  private _transport!: Subject<IMessage>;
  private currentRetryCount = 0;

  private challengeCallback: (
    challenge: Observable<ChallengeMessage>
  ) => Observable<string> = () =>
    throwError(
      Error(
        'When trying to make a WAMP connection, we received a Challenge Message, but no `onChallenge` callback was set.'
      )
    );

  public readonly defaultRetryWhen = (retryOptions?: RetryOptions) => {
    return (attempts: Observable<Error>) => {
      const o = { ...Client.retryDefaults, ...retryOptions };

      const {
        maxRetryDelay,
        initialRetryDelay,
        retryDelayGrowth,
        maxRetries,
      } = o;

      return attempts.pipe(
        mergeMap((ex) => {
          console.error(ex.message);
          const delay = Math.min(
            maxRetryDelay as number,
            Math.pow(retryDelayGrowth as number, ++this.currentRetryCount) +
              (initialRetryDelay ? initialRetryDelay : 0)
          );
          console.log(
            'Reconnecting attempt: ' +
              this.currentRetryCount +
              ', Retrying in: ' +
              (delay / 1000).toPrecision(4) +
              ' seconds.'
          );
          return timer(Math.floor(delay));
        }),
        take(maxRetries as number)
      );
    };
  };

  constructor(
    urlOrTransportOrObs: string | Subject<IMessage> | Observable<ThruwayConfig>,
    realm?: string,
    options: WampOptions = {}
  ) {
    let transportData: Observable<TransportData>;
    if (typeof urlOrTransportOrObs === 'string') {
      this._transport = new WebSocketTransport(urlOrTransportOrObs, [
        'wamp.2.json',
      ]);
      transportData = (of({
        transport: this._transport,
        realm,
        options,
      }) as any) as Observable<TransportData>;
    } else if (urlOrTransportOrObs instanceof Subject) {
      this._transport = (urlOrTransportOrObs as any) as Subject<IMessage>;
      transportData = (of({
        transport: this._transport,
        realm,
        options,
      }) as any) as Observable<TransportData>;
    } else {
      transportData = (urlOrTransportOrObs as Observable<ThruwayConfig>).pipe(
        map((config: ThruwayConfig) => {
          this._transport = new WebSocketTransport(
            config.url,
            ['wamp.2.json'],
            config.autoOpen
          );
          return {
            transport: this._transport,
            realm: config.realm,
            options: config.options || {},
          };
        }) as any
      ) as Observable<TransportData>;
    }

    transportData = transportData.pipe(
      tap(({ transport }) => this.subscription.add(transport)),
      take(1),
      shareReplay(1)
    );

    const messages = transportData.pipe(
      switchMap(({ transport, options: o, realm: r }) =>
        transport.pipe(
          map((msg: IMessage) => {
            if (msg instanceof AbortMessage) {
              // @todo create an exception for this
              throw new Error(
                'Connection ended because ' +
                  JSON.stringify(msg.details) +
                  msg.reason
              );
            }
            return msg as never;
          }),
          tap((msg) => {
            let instance: any = msg;
            if (instance instanceof OpenMessage) {
              this.currentRetryCount = 0;
              o.roles = Client.roles;
              transport.next(new HelloMessage(r, o));
            }
          }),
          race(
            timer(options.timeout || 5000).pipe(
              switchMapTo(throwError(Error('Transport Timeout')))
            )
          ),
          tap({ error: (e) => this._onError.next(e) }),
          retryWhen(o.retryWhen || this.defaultRetryWhen(options.retryOptions))
        )
      ),
      share()
    );

    let remainingMsgs: Observable<IMessage>,
      challengeMsg,
      goodByeMsg,
      abortMsg,
      welcomeMsg: Observable<WelcomeMessage>;

    [challengeMsg, remainingMsgs] = partition(
      messages,
      (msg: any) => msg instanceof ChallengeMessage
    );

    [goodByeMsg, remainingMsgs] = partition(
      remainingMsgs,
      (msg) => msg instanceof GoodbyeMessage
    );

    [abortMsg, remainingMsgs] = partition(
      remainingMsgs,
      (msg) => msg instanceof AbortMessage
    );

    goodByeMsg = goodByeMsg.pipe(tap((v) => this._onClose.next(v)));

    remainingMsgs = remainingMsgs.pipe(merge(goodByeMsg));

    abortMsg = abortMsg.pipe(tap((v) => this._onClose.next(v)));

    const challenge = this.challenge(challengeMsg).pipe(
      combineLatest(transportData),
      tap(([msg, td]: any) => td.transport.next(msg))
    );

    const abortError = abortMsg.pipe(
      map((msg: any) => {
        throw new Error(msg.details.message + ' ' + msg.reason);
      })
    );

    [welcomeMsg, remainingMsgs] = partition(
      remainingMsgs.pipe(
        merge(challenge.pipe(share())),
        merge(abortError.pipe(share()))
      ),
      (msg): any => msg instanceof WelcomeMessage
    ) as [Observable<WelcomeMessage>, Observable<IMessage>];

    this._session = welcomeMsg.pipe(
      combineLatest(transportData),
      map(([msg, td]: any) => ({
        messages: remainingMsgs,
        transport: td.transport,
        welcomeMsg: msg,
      })),
      multicast(() => new ReplaySubject<any>(1)),
      refCount()
    ) as Observable<SessionData>;
  }

  public topic(uri: string, options?: TopicOptions): Observable<EventMessage> {
    return this._session.pipe(
      switchMap(
        ({ transport, messages }: SessionData) =>
          new TopicObservable(uri, options as TopicOptions, messages, transport)
      ),
      takeUntil(this.onClose)
    ) as Observable<EventMessage>;
  }

  public publish<T>(
    uri: string,
    value: Observable<T> | any,
    options?: PublishOptions
  ): Subscription {
    const obs =
      typeof value.subscribe === 'function'
        ? (value as Observable<T>)
        : of(value);
    const completed = new Subject();

    return this._session
      .pipe(
        takeUntil(completed),
        map(({ transport }) =>
          obs.pipe(
            finalize(() => completed.next(0)),
            map((v) => new PublishMessage(Utils.uniqueId(), options as PublishOptions, uri, [v])),
            tap((m) => transport.next(m))
          )
        ),
        exhaust(),
        takeUntil(this.onClose)
      )
      .subscribe();
  }

  public call(
    uri: string,
    args?: Array<any>,
    argskw?: Object,
    options?: CallOptions
  ): Observable<ResultMessage> {
    return this._session.pipe(
      merge(
        this.onClose.pipe(
          flatMap(() => Observable.throw(new Error('Connection Closed')))
        )
      ),
      take(1),
      switchMap(
        ({ transport, messages }: SessionData) =>
          new CallObservable(uri, messages, transport, args, argskw, options)
      )
    ) as Observable<ResultMessage>;
  }

  public register(
    uri: string,
    callback: Function,
    options?: RegisterOptions
  ): Observable<RegisteredMessage | UnregisteredMessage> {
    return this._session.pipe(
      merge(
        this.onClose.pipe(
          flatMap(() => Observable.throw(new Error('Connection Closed')))
        )
      ),
      switchMap(
        ({ transport, messages }: SessionData) =>
          new RegisterObservable(uri, callback, messages, transport, options)
      )
    ) as Observable<RegisteredMessage | UnregisteredMessage>;
  }

  public progressiveCall(
    uri: string,
    args?: Array<any>,
    argskw?: Object,
    options: CallOptions = {}
  ): Observable<ResultMessage> {
    options.receive_progress = true;
    const completed = new Subject();
    let retry = false;

    return this._session.pipe(
      merge(this.onError.pipe(flatMap((e) => Observable.throw(e)))),
      merge(
        this.onClose.pipe(
          flatMap(() => Observable.throw(new Error('Connection Closed')))
        )
      ),
      takeUntil(completed),
      switchMap(({ transport, messages }: SessionData) => {
        const callObs = new CallObservable(
          uri,
          messages,
          transport,
          args,
          argskw,
          options
        );
        return callObs.pipe(finalize(() => completed.next(0)));
      }),
      tap(() => (retry = false)),
      retryWhen((errors: Observable<any>) => {
        return errors.pipe(
          flatMap((e: WampErrorException) => {
            // start retrying when we get a canceled error and continue retrying until we get a value
            if (e.errorUri === 'wamp.error.canceled' || retry) {
              retry = true;
              return of(e);
            }

            return Observable.throw(e);
          }),
          delay(5000)
        );
      })
    ) as Observable<ResultMessage>;
  }

  public progressiveRegister(
    uri: string,
    callback: Function,
    options: RegisterOptions = {}
  ): Observable<any> {
    options.progress = true;
    options.replace_orphaned_sessions = 'yes';
    return this.register(uri, callback, options);
  }

  public onChallenge(
    challengeCallback: (
      challenge: Observable<ChallengeMessage>
    ) => Observable<any>
  ) {
    this.challengeCallback = challengeCallback;
  }

  private challenge = (challengeMsg: Observable<IMessage>) => {
    return challengeMsg.pipe(
      switchMap((msg: any) => {
        try {
          let challengeResult = this.challengeCallback(of(msg));
          return challengeResult.pipe(take(1));
        } catch (e) {
          console.error(e);
          throw new WampChallengeException(msg);
        }
      }),
      map((signature: any) => new AuthenticateMessage(signature)),
      catchError((e) => {
        if (e instanceof WampChallengeException) {
          return of(e.abortMessage());
        }
        return Observable.throw(e);
      })
    );
  };

  public close() {
    this._onClose.next();
  }

  public open() {
    // @todo we should be using a connectable observable for this
    (this._transport as WebSocketTransport<IMessage>).open();
  }

  get onOpen(): Observable<SessionData> {
    return this._session;
  }

  get onClose(): Observable<IMessage> {
    return this._onClose;
  }

  get onError(): Observable<Error> {
    return this._onError;
  }
}

export interface RetryOptions {
  maxRetryDelay?: number;
  initialRetryDelay?: number;
  retryDelayGrowth?: number;
  maxRetries?: number;
}

export interface WampOptions {
  authmethods?: Array<string>;
  roles?: Object;
  role?: string;
  retryWhen?: (attempts: Observable<Error>) => Observable<any>;
  retryOptions?: RetryOptions;
  timeout?: number;

  [propName: string]: any;
}

export interface SessionData {
  messages: Observable<IMessage>;
  transport: Subject<IMessage>;
  welcomeMsg: WelcomeMessage;
}

export interface ThruwayConfig {
  autoOpen?: boolean;
  url: string;
  realm: string;
  options: WampOptions;
}

export interface TransportData {
  transport: Subject<IMessage>;
  realm: string;
  options: WampOptions;
}
