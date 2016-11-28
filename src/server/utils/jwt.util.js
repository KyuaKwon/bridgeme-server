import fs from 'fs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const JWT_CREATE_OPTION = { algorithm: 'HS256', expiresIn: '60min' };

let jwtKey;

mongoose.model('key').findOne({ index: 0 }).exec()
  .then((key) => {
    jwtKey = process.env.NODE_ENV === 'test' ? 'thisistestsecret' : key.jwtKey;
  });

export default {
  apiProtector(req, res, next) {
    jwt.verify(req.headers.access_token, jwtKey, function (err, decoded) {
      if (err) {
        res.status(401).json({ err_point: err.message });
      } else {
        req.user = decoded;
        return next();
      }
    });
  },

  generatePayload(user) {
    return { _id: user._id, name: user.name, email: user.email };
  },

  createAccessToken(user) {
    return jwt.sign(this.generatePayload(user), jwtKey, JWT_CREATE_OPTION);
  },

  updateAccessToken(previousToken, updateTokenCallback) {
    jwt.verify(previousToken, jwtKey, { ignoreExpiration: true }, function (err, decodedUser) {
      if (typeof updateTokenCallback === 'function') {
        updateTokenCallback(err, decodedUser ? this.createAccessToken(decodedUser) : undefined);
      }
    }.bind(this));
  },

};

