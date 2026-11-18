import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extract } from '../src/map/extract.ts'
import { buildNow, openMap } from '../src/map/indexer.ts'
import { LANGS, langOf, type LangId } from '../src/map/languages.ts'
import { makeRepo } from './helpers.ts'

type Def = [qualified: string, kind: string, start: number, end: number]
type Fixture = {
  lang: LangId
  file: string
  src: string
  defs: Def[]
  /** a call the file makes: its name and the definition it is made from */
  call: [name: string, from: string]
  /** a link the whole-project pass must resolve between two definitions of the file */
  link: [from: string, to: string]
}

const FIXTURES: Fixture[] = [
  {
    lang: 'bash',
    file: 'run.sh',
    src: `#!/bin/bash
helper() {
  echo "hi"
}

function build_all {
  helper
  make clean
}

build_all
`,
    defs: [['helper', 'function', 2, 4], ['build_all', 'function', 6, 9]],
    call: ['helper', 'build_all'],
    link: ['build_all', 'helper'],
  },
  {
    lang: 'zig',
    file: 'point.zig',
    src: `const std = @import("std");

pub const Point = struct {
    x: i32,
    pub fn new(x: i32) Point {
        return Point{ .x = helper(x) };
    }
    fn len(self: Point) i32 {
        return self.x;
    }
};

fn helper(v: i32) i32 {
    return v;
}

pub fn main() void {
    const p = Point.new(1);
    std.debug.print("x", .{});
    _ = p.len();
}
`,
    defs: [['Point', 'class', 3, 11], ['Point.new', 'method', 5, 7], ['Point.len', 'method', 8, 10], ['helper', 'function', 13, 15], ['main', 'function', 17, 21]],
    call: ['helper', 'Point.new'],
    link: ['main', 'Point.new'],
  },
  {
    lang: 'ocaml',
    file: 'cart.ml',
    src: `module Cart = struct
  type item = { price : int }

  let helper x = x + 1

  let total items =
    List.fold_left (fun acc i -> acc + helper i.price) 0 items
end

class counter = object
  method incr = 1
end

module type SHOP = sig
  val run : unit -> unit
end

let main () = Cart.total [] |> print_int
`,
    defs: [['Cart', 'module', 1, 8], ['Cart.item', 'type', 2, 2], ['Cart.helper', 'method', 4, 4], ['Cart.total', 'method', 6, 7], ['counter', 'class', 10, 12], ['counter.incr', 'method', 11, 11], ['SHOP', 'interface', 14, 16], ['main', 'function', 18, 18]],
    call: ['helper', 'Cart.total'],
    link: ['Cart.total', 'Cart.helper'],
  },
  {
    lang: 'haskell',
    file: 'Cart.hs',
    src: `module Shop.Cart (total) where

data Item = Item { price :: Int } | Free

class Priced a where
  cost :: a -> Int

total :: [Item] -> Int
total items = foldl' add 0 items
  where
    add acc i = acc + helper i

helper :: Int -> Int
helper x = x + 1

main :: IO ()
main = print (total [])
`,
    defs: [['Item', 'type', 3, 3], ['Priced', 'interface', 5, 6], ['total', 'function', 9, 11], ['total.add', 'function', 11, 11], ['helper', 'function', 14, 14], ['main', 'function', 17, 17]],
    call: ['helper', 'total.add'],
    link: ['main', 'total'],
  },
  {
    lang: 'julia',
    file: 'shop.jl',
    src: `module Shop

struct Item
    price::Int
end

function helper(x)
    return x + 1
end

total(items) = sum(helper(i.price) for i in items)

function Base.show(io::IO, c)
    println(io, total(c))
end

end
`,
    defs: [['Shop', 'module', 1, 17], ['Shop.Item', 'class', 3, 5], ['Shop.helper', 'method', 7, 9], ['Shop.total', 'method', 11, 11], ['Shop.show', 'method', 13, 15]],
    call: ['total', 'Shop.show'],
    link: ['Shop.show', 'Shop.total'],
  },
  {
    lang: 'clojure',
    file: 'cart.clj',
    src: `(ns shop.cart
  (:require [clojure.string :as str]))

(defn helper
  "Adds one."
  [x]
  (inc x))

(defn- total [items]
  (reduce + (map helper items)))

(defprotocol Priced
  (cost [this]))

(defrecord Item [price]
  Priced
  (cost [this] (helper price)))

(defn -main [& args]
  (println (total [1 2]))
  (str/join "," args))
`,
    defs: [['helper', 'function', 4, 7], ['total', 'function', 9, 10], ['Priced', 'interface', 12, 13], ['Priced.cost', 'method', 13, 13], ['Item', 'class', 15, 17], ['Item.cost', 'method', 17, 17], ['-main', 'function', 19, 21]],
    call: ['total', '-main'],
    link: ['Item.cost', 'helper'],
  },
  {
    lang: 'nix',
    file: 'default.nix',
    src: `{ pkgs ? import <nixpkgs> {} }:
let
  helper = x: x + 1;
  total = items: builtins.foldl' (a: b: a + helper b) 0 items;
  plain = 5;
in
{
  result = total [ 1 2 3 ];
}
`,
    defs: [['helper', 'function', 3, 3], ['total', 'function', 4, 4]],
    call: ['helper', 'total'],
    link: ['total', 'helper'],
  },
  {
    lang: 'solidity',
    file: 'Cart.sol',
    src: `pragma solidity ^0.8.0;

library MathLib {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        return a + b;
    }
}

contract Cart {
    event Paid(uint256 amount);

    function helper(uint256 x) internal pure returns (uint256) {
        return MathLib.add(x, 1);
    }

    function pay() public {
        emit Paid(helper(1));
    }
}

function freeFn(uint256 x) pure returns (uint256) { return x; }
`,
    defs: [['MathLib', 'module', 3, 7], ['MathLib.add', 'method', 4, 6], ['Cart', 'class', 9, 19], ['Cart.Paid', 'method', 10, 10], ['Cart.helper', 'method', 12, 14], ['Cart.pay', 'method', 16, 18], ['freeFn', 'function', 21, 21]],
    call: ['add', 'Cart.helper'],
    link: ['Cart.helper', 'MathLib.add'],
  },
  {
    lang: 'r',
    file: 'cart.R',
    src: `helper <- function(x) {
  x + 1
}

total = function(items) {
  sum(sapply(items, helper))
}

Cart <- setRefClass("Cart", fields = list(n = "numeric"),
  methods = list(
    add = function(x) { n <<- n + helper(x) }
  )
)

main <- function() {
  stats::sd(c(1, 2))
  total(c(1, 2))
}
`,
    defs: [['helper', 'function', 1, 3], ['total', 'function', 5, 7], ['Cart', 'class', 9, 13], ['Cart.add', 'method', 11, 11], ['main', 'function', 15, 18]],
    call: ['total', 'main'],
    link: ['Cart.add', 'helper'],
  },
  {
    lang: 'erlang',
    file: 'cart.erl',
    src: `-module(cart).
-record(item, {price}).

total(Items) ->
    lists:foldl(fun(I, A) -> A + helper(I) end, 0, Items).

helper(X) when X > 0 ->
    other:ping(X),
    X + 1.

run() ->
    T = total([]),
    io:format("~p", [T]).
`,
    defs: [['cart', 'module', 1, 1], ['item', 'class', 2, 2], ['total', 'function', 4, 5], ['helper', 'function', 7, 9], ['run', 'function', 11, 13]],
    call: ['helper', 'total'],
    link: ['run', 'total'],
  },
  {
    lang: 'gleam',
    file: 'cart.gleam',
    src: `import gleam/list

pub type Item {
  Item(price: Int)
}

fn helper(x: Int) -> Int {
  x + 1
}

pub fn total(items: List(Item)) -> Int {
  list.fold(items, 0, fn(acc, i) { acc + helper(i.price) })
}

pub fn main() {
  total([]) |> helper
}
`,
    defs: [['Item', 'type', 3, 5], ['helper', 'function', 7, 9], ['total', 'function', 11, 13], ['main', 'function', 15, 17]],
    call: ['helper', 'total'],
    link: ['main', 'total'],
  },
  {
    lang: 'perl',
    file: 'Cart.pm',
    src: `package Shop::Cart;
use strict;

sub helper {
    my $x = shift;
    return $x + 1;
}

sub total {
    my ($self) = @_;
    my $sum = helper(1);
    $self->add(2);
    return $sum;
}

sub add { return 1 }
1;
`,
    defs: [['helper', 'function', 4, 7], ['total', 'function', 9, 14], ['add', 'function', 16, 16]],
    call: ['add', 'total'],
    link: ['total', 'helper'],
  },
  {
    lang: 'elm',
    file: 'Cart.elm',
    src: `module Shop.Cart exposing (total)

type alias Item =
    { price : Int }

type Msg = Inc | Dec

helper : Int -> Int
helper x =
    x + 1

total : List Item -> Int
total items =
    List.sum (List.map (\\i -> helper i.price) items)

update : Msg -> Int -> Int
update msg model =
    case msg of
        Inc -> helper model
        Dec -> model - 1
`,
    defs: [['Item', 'type', 3, 4], ['Msg', 'type', 6, 6], ['helper', 'function', 9, 10], ['total', 'function', 13, 14], ['update', 'function', 17, 20]],
    call: ['helper', 'total'],
    link: ['update', 'helper'],
  },
  {
    lang: 'gdscript',
    file: 'player.gd',
    src: `class_name Player
extends Node2D

enum State { IDLE, RUN }

class Inner:
	func ping():
		return 1

func _ready():
	helper(1)
	self.move()

func helper(x):
	return x + 1

func move() -> void:
	print(helper(2))
`,
    defs: [['Player', 'class', 1, 18], ['Player.State', 'enum', 4, 4], ['Player.Inner', 'class', 6, 8], ['Player.Inner.ping', 'method', 7, 8], ['Player._ready', 'method', 10, 12], ['Player.helper', 'method', 14, 15], ['Player.move', 'method', 17, 18]],
    call: ['helper', 'Player._ready'],
    link: ['Player.move', 'Player.helper'],
  },
  {
    lang: 'commonlisp',
    file: 'shop.lisp',
    src: `(defpackage :shop (:use :cl))
(in-package :shop)

(defun helper (x)
  "Adds one."
  (+ x 1))

(defun total (items)
  (reduce #'+ (mapcar #'helper items))
  (helper 2))

(defclass item ()
  ((price :initarg :price)))

(defmethod cost ((i item))
  (total (list i)))
`,
    defs: [['helper', 'function', 4, 6], ['total', 'function', 8, 10], ['item', 'class', 12, 13], ['cost', 'function', 15, 16]],
    call: ['helper', 'total'],
    link: ['cost', 'total'],
  },
  {
    lang: 'elisp',
    file: 'shop.el',
    src: `;;; shop.el --- cart  -*- lexical-binding: t; -*-

(defun shop-helper (x)
  "Add one to X."
  (+ x 1))

(defun shop-total (items)
  (let ((sum 0))
    (dolist (i items) (setq sum (+ sum (shop-helper i))))
    sum))

(cl-defun shop-run (&key n) (shop-total (list n)))
`,
    defs: [['shop-helper', 'function', 3, 5], ['shop-total', 'function', 7, 10], ['shop-run', 'function', 12, 12]],
    call: ['shop-helper', 'shop-total'],
    link: ['shop-run', 'shop-total'],
  },
  {
    lang: 'racket',
    file: 'shop.rkt',
    src: `#lang racket

(define (helper x)
  (+ x 1))

(define (total items)
  (foldl + 0 (map helper items)))

(define add2
  (lambda (x) (helper (helper x))))

(struct item (price))

(define (main)
  (displayln (total (list 1 2)))
  (add2 3))
`,
    defs: [['helper', 'function', 3, 4], ['total', 'function', 6, 7], ['add2', 'function', 9, 10], ['item', 'class', 12, 12], ['main', 'function', 14, 16]],
    call: ['helper', 'add2'],
    link: ['main', 'total'],
  },
  {
    lang: 'scheme',
    file: 'shop.scm',
    src: `(define (helper x)
  (+ x 1))

(define (total items)
  (fold-left + 0 (map helper items)))

(define add2
  (lambda (x) (helper (helper x))))

(define-record-type item (make-item price) item? (price item-price))

(define (main)
  (display (total (list 1 2)))
  (add2 3))
`,
    defs: [['helper', 'function', 1, 2], ['total', 'function', 4, 5], ['add2', 'function', 7, 8], ['item', 'class', 10, 10], ['main', 'function', 12, 14]],
    call: ['helper', 'add2'],
    link: ['main', 'total'],
  },
  {
    lang: 'ada',
    file: 'shop.adb',
    src: `with Ada.Text_IO;

package body Shop is

   function Helper (X : Integer) return Integer is
   begin
      return X + 1;
   end Helper;

   procedure Show (X : Integer) is
   begin
      Ada.Text_IO.Put_Line (Integer'Image (Helper (X)));
      Helper_Proc;
   end Show;

   procedure Helper_Proc is
   begin
      null;
   end Helper_Proc;

end Shop;
`,
    defs: [['Shop', 'module', 3, 21], ['Shop.Helper', 'method', 5, 8], ['Shop.Show', 'method', 10, 14], ['Shop.Helper_Proc', 'method', 16, 19]],
    call: ['Helper_Proc', 'Shop.Show'],
    link: ['Shop.Show', 'Shop.Helper_Proc'],
  },
  {
    lang: 'rescript',
    file: 'Cart.res',
    src: `module Cart = {
  type item = {price: int}

  let helper = x => x + 1

  let total = items => Belt.Array.reduce(items, 0, (a, i) => a + helper(i.price))
}

type mode = Fast | Slow

let main = () => {
  Js.log(Cart.total([]))
}

let go = x => x->Cart.helper
`,
    defs: [['Cart', 'module', 1, 7], ['Cart.item', 'type', 2, 2], ['Cart.helper', 'method', 4, 4], ['Cart.total', 'method', 6, 6], ['mode', 'type', 9, 9], ['main', 'function', 11, 13], ['go', 'function', 15, 15]],
    call: ['helper', 'Cart.total'],
    link: ['main', 'Cart.total'],
  },
  {
    lang: 'glsl',
    file: 'shade.frag',
    src: `#version 330 core

struct Light {
    vec3 pos;
};

float helper(float x) {
    return x * 2.0;
}

vec3 shade(vec3 n) {
    float d = helper(dot(n, vec3(1.0)));
    return vec3(d);
}

void main() {
    gl_FragColor = vec4(shade(vec3(1.0)), 1.0);
}
`,
    defs: [['Light', 'class', 3, 5], ['helper', 'function', 7, 9], ['shade', 'function', 11, 14], ['main', 'function', 16, 18]],
    call: ['helper', 'shade'],
    link: ['main', 'shade'],
  },
  {
    lang: 'cuda',
    file: 'run.cu',
    src: `__device__ float helper(float x) {
    return x * 2.0f;
}

__global__ void kernel(float *a) {
    a[0] = helper(a[0]);
}

class Runner {
public:
    void run(float *d) {
        kernel<<<1, 32>>>(d);
    }
};

namespace util {
int twice(int x) { return x * 2; }
}

int main() {
    Runner r;
    r.run(nullptr);
    return util::twice(2);
}
`,
    defs: [['helper', 'function', 1, 3], ['kernel', 'function', 5, 7], ['Runner', 'class', 9, 14], ['Runner.run', 'method', 11, 13], ['util', 'module', 16, 18], ['util.twice', 'method', 17, 17], ['main', 'function', 20, 24]],
    call: ['helper', 'kernel'],
    link: ['Runner.run', 'kernel'],
  },
  {
    lang: 'terraform',
    file: 'main.tf',
    src: `variable "region" {
  type = string
}

locals {
  prefix = format("app-%s", var.region)
}

resource "aws_s3_bucket" "logs" {
  bucket = "\${local.prefix}-logs"
}

module "network" {
  source = "./modules/network"
  region = var.region
}

resource "aws_instance" "web" {
  subnet_id = module.network.subnet_id
  bucket    = aws_s3_bucket.logs.id
  name      = lower(local.prefix)
}

output "bucket_id" {
  value = aws_s3_bucket.logs.id
}
`,
    defs: [['region', 'variable', 1, 3], ['prefix', 'variable', 6, 6], ['logs', 'class', 9, 11], ['network', 'module', 13, 16], ['web', 'class', 18, 22], ['bucket_id', 'variable', 24, 26]],
    call: ['logs', 'web'],
    link: ['web', 'logs'],
  },
  {
    lang: 'astro',
    file: 'Page.astro',
    src: `---
import { api } from './api'
const title = 'x'
function load() { api.get() }
---
<h1>{title}</h1>
<script>
  function click() { load() }
</script>
`,
    defs: [['load', 'function', 4, 4], ['click', 'function', 8, 8]],
    call: ['load', 'click'],
    link: ['click', 'load'],
  },
]

const sym = (f: Awaited<ReturnType<typeof extract>>, qualified: string, at: number) => f.syms.filter(s => s.qualified === qualified)[at]

for (const fx of FIXTURES) {
  test(`${LANGS[fx.lang].label} (${fx.lang}): definitions with kinds, containers and lines, and calls`, async () => {
    const f = await extract(fx.lang, fx.src)
    for (const [qualified, kind, start, end] of fx.defs) {
      const s = sym(f, qualified, 0)
      assert.ok(s, `${fx.lang}: no definition ${qualified}; found ${f.syms.map(x => x.qualified).join(', ')}`)
      assert.equal(s.kind, kind, `${fx.lang}: kind of ${qualified}`)
      assert.equal(s.start, start, `${fx.lang}: start of ${qualified}`)
      assert.equal(s.end, end, `${fx.lang}: end of ${qualified}`)
    }
    assert.equal(f.syms.length, fx.defs.length, `${fx.lang}: extra definitions: ${f.syms.map(x => x.qualified).join(', ')}`)
    const [name, from] = fx.call
    assert.ok(
      f.refs.some(r => r.name === name && r.from === from),
      `${fx.lang}: no call to ${name} from ${from}; found ${f.refs.map(r => `${r.name}<-${r.from}`).join(', ')}`,
    )
  })

  test(`${LANGS[fx.lang].label} (${fx.lang}): a call is linked between two definitions`, async () => {
    const r = makeRepo({ [fx.file]: fx.src })
    try {
      await buildNow(r.root)
      const rows = openMap(r.root)
        .sql(
          `SELECT s.qualified AS "from", d.qualified AS "to" FROM edges e
           JOIN symbols d ON d.id = e.dst JOIN symbols s ON s.id = e.src`,
        )
        .all() as { from: string; to: string }[]
      const [from, to] = fx.link
      assert.ok(
        rows.some(l => l.from === from && l.to === to),
        `${fx.lang}: no link ${from} -> ${to}; found ${rows.map(l => `${l.from}->${l.to}`).join(', ')}`,
      )
    } finally {
      r.cleanup()
    }
  })
}

test('every new language is found by its file extension', () => {
  for (const fx of FIXTURES) assert.equal(langOf(fx.file), fx.lang, fx.file)
  assert.equal(langOf('deploy/run.zsh'), 'bash')
  assert.equal(langOf('src/Main.hs'), 'haskell')
  assert.equal(langOf('infra/vars.tfvars'), 'terraform')
})

test('namespaced and qualified calls go by name; parameter and binding lists are not calls', async () => {
  const clj = await extract('clojure', '(defn run [items]\n  (str/join "," items)\n  (shop.util/helper 1))\n')
  assert.deepEqual(clj.refs.map(r => [r.name, r.receiver]), [['join', null], ['helper', null]])
  const el = await extract('elisp', '(defun f (a b)\n  (let ((x 1) (y 2)) (g x y)))\n')
  assert.deepEqual(el.refs.map(r => r.name), ['g'])
  const rkt = await extract('racket', '(define (f a)\n  (let ([x 1] [y 2]) (g x y))\n  (lambda (z) (h z)))\n')
  assert.deepEqual(rkt.refs.map(r => r.name), ['g', 'h'])
  const lisp = await extract('commonlisp', '(defun f (a (b c))\n  (let ((x 1)) (g x)))\n')
  assert.deepEqual(lisp.refs.map(r => r.name), ['g'])
  const ml = await extract('ocaml', 'let run x = List.map helper x |> Util.show\n')
  assert.deepEqual(ml.refs.map(r => [r.name, r.receiver]), [['map', null], ['show', null]])
})

test('Zig: only pub declarations are exported', async () => {
  const f = await extract('zig', 'pub fn open() void {}\nfn hidden() void {}\n')
  assert.equal(sym(f, 'open', 0)?.exported, true)
  assert.equal(sym(f, 'hidden', 0)?.exported, false)
})

test('Astro: the frontmatter and its script blocks keep their real line numbers', async () => {
  const f = await extract('astro', '---\nimport { api } from "./api"\nconst x = 1\n---\n<p>{x}</p>\n')
  assert.deepEqual(f.imps, [{ source: './api', local: 'api', imported: 'api' }])
  const none = await extract('astro', '<p>no frontmatter</p>\n<script>function a() { b() }</script>\n')
  assert.equal(sym(none, 'a', 0)?.start, 2)
})

test('files in the new languages that do not parse cleanly still give what can be read, and never throw', async () => {
  const garbage = '(((((\n{{{{\nend end end\n"unterminated\n\x00\x01 fn ( [ <<<\n'
  for (const fx of FIXTURES) {
    await assert.doesNotReject(extract(fx.lang, garbage), fx.lang)
    await assert.doesNotReject(extract(fx.lang, ''), fx.lang)
    // a half-written copy of a real file still gives its first definition
    const f = await extract(fx.lang, fx.src.slice(0, Math.floor(fx.src.length * 0.7)))
    assert.ok(f.syms.length >= 1, `${fx.lang}: nothing recovered from a truncated file`)
  }
})
