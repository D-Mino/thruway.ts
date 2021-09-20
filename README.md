# Thruway.ts

This project is a WAMP client written in TypeScript that uses RxJS v6 Observables instead of promises and event emitters.
It's designed to work with modern frontend frameworks like Angular v8+.
## Installation

```BASH
npm install thruway.ts
npm install rxjs
```

## Usage

```JS
import { Client } from "thruway.ts";

const wamp = new Client('ws://localhost:9090', 'realm1');
```

### Call

```JS
wamp.call('add.rpc', [1, 2])
    .map((r: ResultMessage) => r.args[0])
    .subscribe(r => console.log(r));
```

### Register

```JS
wamp.register('add.rpc', (a, b) => a + b).subscribe();
```

If you need keyword arguments, you can set the `extended` option.

```JS
wamp.register('add.rpc', (args, argskw) => argskw.a + argskw.b, {extended: true}).subscribe();
```

### Publish to topic

```JS
wamp.publish('example.topic', 'some value');
wamp.publish('example.topic', Observable.interval(1000));

```

### Subscribe to topic

```JS
wamp.topic('example.topic').subscribe((v)=>console.log(v));
```

### Angular Example

Create a wamp service

```JS
import {Injectable} from '@angular/core';
import {Client} from 'thruway.ts';

@Injectable()
export class WampService extends Client {
    constructor() {
        super('wss://demo.crossbar.io/ws', 'realm1');
    }
}
```

Inject and use the service in your component

```JS
import {Component} from '@angular/core';
import {WampService} from '../wamp.service';
import {Observable} from 'rxjs/Observable';
import {EventMessage} from 'thruway.js/src/Messages/EventMessage';

@Component({
    selector: 'app-counter',
    template: '<span>{{counter | async}}</span>'
})
export class CounterComponent {
    counter: Observable<number> = this.wamp
        .topic('com.myapp.counter')
        .map((r: EventMessage) => r.args[0]);

    constructor(private wamp: WampService) {}
}
```
