import * as matchController from './match.controller';
import * as mailingUtil from '../utils/mailing.util';
import AWS from 'aws-sdk';
import jwtUtil from '../utils/jwt.util';
import mailStrings from '../config/json/mail.strings';
import mongoose from 'mongoose';
import request from 'request-promise';
import userCallback from '../config/json/user.callback';
import commonCallback from '../config/json/common.callback';
import crypto from 'crypto';

/*
 * Methods about user, register user and handle session
 */

const Key = mongoose.model('key');
const Match = mongoose.model('match');
const ObjectId = mongoose.Types.ObjectId;
const User = mongoose.model('user');
const SecretCode = mongoose.model('secretCode');
const platform = { local: '0', facebook: '1', linkedin: '2' };
const defaultProfileUrl = 'https://s3.ap-northeast-2.amazonaws.com/yodabucket/profile/default/pattern.png';

// FB Graph API constant vars.
const FB_GRAPH_BASE_URL = 'https://graph.facebook.com/';
const FB_GRAPH_GET_MY_PROFILE_URI = 'me/';
const FB_GRAPH_GET_PICTURE_URI = 'picture/';
const FB_GRAPH_CRAWL_PARAMS = 'name,email,locale,timezone,education,work,location,verified';

export function getMentorList(req, res, next) {
  const exceptList = [];
  const pendingList = [];
  const project = {
    mentee_id: 1,
    mentor_id: 1,
  };
  let match = {
    mentor_id: ObjectId(req.user._id),
  };
  findConnection(match, project, 'mentee_id')
    .then((menteeList) => {
      menteeList.forEach(user => exceptList.push(user.mentee_id));
      match = {
        mentee_id: ObjectId(req.user._id),
        status: matchController.MATCH_STATUS.ACCEPTED,
      };
      return findConnection(match, project, 'mentor_id');
    })
    .then((mentorList) => {
      mentorList.forEach(user => exceptList.push(user.mentor_id));
      match = {
        mentee_id: ObjectId(req.user._id),
        status: matchController.MATCH_STATUS.PENDING,
      };
      return findConnection(match, project, 'mentee_id');
    })
    .then((pendingStatus) => {
      pendingStatus.forEach(user => pendingList.push(user.mentor_id.toString()));
      return User.find({ _id: { $ne: req.user._id, $nin: exceptList, }, mentorMode: { $ne: false }, })
        .sort({ stamp_login: -1 }).exec();
    })
    .then((user) => {
      return Promise.all(user, user.map((item) => {
        if (pendingList.includes(item._id.toString())) {
          item.pending = true;
        }
      }));
    })
    .then((user) => {
      res.status(200).json(user);
    })
    .catch((err) => {
      res.status(400).json({ err_point: userCallback.ERR_MONGOOSE, err: err });
    });
}

function findConnection(match, project, localField) {
  return Match.aggregate([
    {
      $match: match,
    },
    {
      $project: project,
    },
    {
      $lookup: {
        from: 'users',
        localField: localField,
        foreignField: '_id',
        as: 'list',
      },
    },
  ]).exec();
}

// Return my profile.
export function getMyProfile(req, res, next) {
  User.findOne({ _id: req.user._id }).exec()
    .then((myProfile) => {
      res.status(200).json(myProfile);
    })
    .catch((err) => {
      res.status(400).json({ err_point: userCallback.ERR_MONGOOSE, err: err });
    });
}

// Return profile by _id.
export function getProfileById(req, res, next) {
  let userProfile = {};

  User.findOne({ _id: req.params._id }).exec()
    .then((profile) => {
      userProfile = JSON.parse(JSON.stringify(profile));
      return Match.findOne({ mentor_id: userProfile._id, mentee_id: req.user._id }).exec();
    })
    .then((matchAsMentee) => {
      userProfile.relation = {};
      userProfile.relation.asMentee =
        matchAsMentee ? matchAsMentee.status : matchController.MATCH_STATUS.REJECTED;
      return Match.findOne({ mentor_id: req.user._id, mentee_id: userProfile._id }).exec();
    })
    .then((matchAsMentor) => {
      userProfile.relation.asMentor =
        matchAsMentor ? matchAsMentor.status : matchController.MATCH_STATUS.REJECTED;
      res.status(200).json(userProfile);
    })
    .catch((err) => {
      res.status(400).json({ err_point: userCallback.ERR_MONGOOSE, err: err });
    });
}

export function localSignUp(req, res, next) {
  let cipher = crypto.createCipher('aes256', req.body.password);
  cipher.update(req.body.email, 'ascii', 'hex');
  let cryptoPassword = cipher.final('hex');

  let registrationData = {
    email: req.body.email,
    password: cryptoPassword,
    platform_type: 0,
    deviceToken: [],
    profile_picture: defaultProfileUrl,
  };

  validateEmail(registrationData.email)
    .then((result) => {
      if (result) {
        return User.findOne({ email: registrationData.email }).exec();
      } else {
        throw new Error(userCallback.ERR_INVALID_EMAIL_FORMAT);
      }
    })
    .then((existingUser) => {
      if (existingUser) {
        res.status(201).json({ msg: userCallback.ERR_EXISTING_EMAIL });
      } else {
        registrationData.deviceToken.push(req.body.deviceToken);
        return User(registrationData).save();
      }
    })
    .then((registeredUser) => {
      return stampUser(registeredUser);
    })
    .then((stampedUser) => {
      if (stampedUser) {
        res.status(201).json({
          user: stampedUser,
          access_token: jwtUtil.createAccessToken(stampedUser),
        });
      } else {
        throw new Error(userCallback.ERR_FAIL_REGISTER);
      }
    })
    .catch((err) => {
      res.status(400).json({ err_msg: err.message });
    });
}

export function localSignIn(req, res, next) {
  let cipher = crypto.createCipher('aes256', req.body.password);
  cipher.update(req.body.email, 'ascii', 'hex');
  let cryptoPassword = cipher.final('hex');

  User.findOne({ email: req.body.email }).exec()
    .then((existingUser) => {
      if (!existingUser) {
        throw new Error(userCallback.ERR_USER_NOT_FOUND);
      } else {
        if (cryptoPassword === existingUser.password) {
          return stampDeviceToken(req.body.deviceToken, existingUser);
        } else {
          throw new Error(userCallback.ERR_WRONG_PASSWORD);
        }
      }
    })
    .then((user) => {
      if (user) {
        return stampUser(user);
      } else {
        throw new Error(userCallback.ERR_FAIL_SIGNIN);
      }
    })
    .then((stampedUser) => {
      res.status(200).json({
        msg: userCallback.SUCCESS_SIGNIN,
        user: stampedUser,
        access_token: jwtUtil.createAccessToken(stampedUser),
      });
    })
    .catch((err) => {
      res.status(400).json({ err_msg: err.message });
    });
}

export function requestSecretCode(req, res, next) {
  if (req.body.email) {
    User.findOne({ email: req.body.email }).exec()
      .then((user) => {
        if (!user) {
          throw new Error(userCallback.ERR_USER_NOT_FOUND);
        } else {
          return SecretCode.findOne({ email: req.body.email, isValid: true }).exec();
        }
      })
      .then((validSecretCode) => {
        if (validSecretCode) {
          SecretCode.update({ _id: validSecretCode._id }, { $set: { isValid: false } }).exec()
            .catch((err) => {
              throw new Error(userCallback.ERR_FAIL_SECRETCODE);
            });
        }

        let cipher = crypto.createCipher('aes256', req.body.email);
        let secretCode = new SecretCode();
        secretCode.email = req.body.email;
        secretCode.secretCode
          = cipher.update(new Date().toISOString(), 'utf-8', 'hex') + cipher.final('hex');
        return secretCode.save();
      })
      .then((secretCode) => {
        mailingUtil.sendEmail(req.body.email, mailStrings.RESETPW_SUBJECT,
          mailStrings.RESETPW_HTML, secretCode.secretCode);
        res.status(201).json({ secretCode: secretCode.secretCode });
      })
      .catch((err) => {
        res.status(400).json({ err_msg: err.message });
      });
  } else {
    res.status(400).json({ err_msg: commonCallback.ERR_WRONG_PARAMETER });
  }
}

export function resetPassword(req, res, next) {
  let cipher = crypto.createCipher('aes256', req.body.password);
  cipher.update(req.body.email, 'ascii', 'hex');
  let crytoPassword = cipher.final('hex');

  User.findOne({ email: req.body.email }).exec()
    .then((user) => {
      if (!user) {
        throw new Error(userCallback.ERR_USER_NOT_FOUND);
      } else {
        SecretCode.findOne({ secretCode: req.body.secretCode }).exec()
          .then((secretCode) => {
            if (secretCode.isValid) {
              return User.update(
                { email: req.body.email },
                { password: crytoPassword },
                { upsert: true }).exec();
            } else {
              throw new Error(userCallback.ERR_INVALID_SECRETCODE);
            }
          })
          .then((updatedUser) => {
            res.status(200).json({ msg: userCallback.SUCCESS_RESET_PASSWORD });
          })
          .catch((err) => {
            throw new Error(userCallback.ERR_FAIL_RESETPW);
          });
      }
    })
    .catch((err) => {
      res.status(400).json({ err_point: err.message });
    });
}

export function signIn(req, res, next) {
  if (req.body.platform_type === platform.facebook) {
    let registrationData;
    crawlByAccessTokenFacebook(req.body.access_token)
      .then((facebookResult) => {
        registrationData = {
          name: facebookResult.name,
          email: facebookResult.email,
          languages: facebookResult.languages,
          location: facebookResult.location ? facebookResult.location.name : undefined,
          education: facebookResult.education,
          experience: facebookResult.work,
          platform_id: facebookResult.id,
          platform_type: req.body.platform_type,
          locale: facebookResult.locale,
          timezone: facebookResult.timezone,
          profile_picture: facebookResult.profile_picture,
        };
        return User.findOne({ email: registrationData.email }).exec();
      })
      .then((existingUser) => {
        if (!existingUser) {
          registrationData.deviceToken = [];
          registrationData.deviceToken.push(req.body.deviceToken);
          new User(registrationData).save()
            .then((registeredUser) => {
              return stampUser(registeredUser);
            })
            .then((stampedUser) => {
              res.status(201).json({
                msg: userCallback.SUCCESS_SIGNIN,
                user: stampedUser,
                access_token: jwtUtil.createAccessToken(stampedUser),
              });
            })
            .catch((err) => {
              res.status(400).json({ err_point: userCallback.ERR_FAIL_REGISTER });
            });
        } else {
          stampDeviceToken(req.body.deviceToken, existingUser)
            .then(user => stampUser(user))
            .then((stampedUser) => {
              res.status(200).json({
                msg: userCallback.SUCCESS_SIGNIN,
                user: stampedUser,
                access_token: jwtUtil.createAccessToken(stampedUser),
              });
            })
            .catch((err) => {
              res.status(400).json({ err_point: userCallback.ERR_FAIL_SIGNIN });
            });
        }
      })
      .catch((err) => {
        res.status(400).json(err);
      });
  } else if (req.body.platform_type === platform.linkedin) {
    // TODO : Validiate accesstoken from linkedin API server.
    res.status(400).send("Doesn't support yet.");
  } else {
    res.status(400).json({ err_point: userCallback.ERR_INVALID_PLATFORM });
  }
}

export function updateAccessToken(req, res, next) {
  jwtUtil.updateAccessToken(req.headers.access_token, (err, newAccessToken)=> {
    if (!err) {
      res.status(200).json({ access_token: newAccessToken });
    }else {
      res.status(401).json({ err_point: err.message });
    }
  });
}

export function validateAccessToken(req, res, next) {
  res.status(200).json({ msg: userCallback.SUCCESS_CHECK_ACCESS_TOKEN });
}

function stampUser(user) {
  return new Promise((resolve, reject) => {
    User.update({ _id: user._id }, { stamp_login: Date.now() }).exec()
      .then((data) => {
        resolve(user);
      })
      .catch((err) => {
        reject();
      });
  });
}

function stampDeviceToken(token, user) {
  return new Promise((resolve, reject) => {
    User.findOne({ _id: user._id }).exec()
      .then((user) => {
        if (user.deviceToken.includes(token) || token === null) {
          resolve(user);
        } else {
          user.deviceToken.push(token);
          User.update({ _id: user._id }, { deviceToken: user.deviceToken }).exec();
        }
      })
      .then((data) => {
        resolve(user);
      })
      .catch((err) => {
        reject(false);
      });
  });
}

function crawlByAccessTokenFacebook(accessToken) {
  return new Promise((resolve, reject) => {
    // Crawl user data from facebook by access token.
    let result;
    request({
      method: 'GET',
      url: FB_GRAPH_BASE_URL + FB_GRAPH_GET_MY_PROFILE_URI,
      qs: { fields: FB_GRAPH_CRAWL_PARAMS, access_token: accessToken },
      resolveWithFullResponse: true,
    })
      .then((facebookDataResult) => {
        result = JSON.parse(facebookDataResult.body);

        // if HTTP request&response successfully.
        if (facebookDataResult.statusCode === 200 && result.verified === true) {
          // Crawl user profile_picture from facebook by access token.
          return request({
            method: 'GET',
            url: FB_GRAPH_BASE_URL + (result.id + '/') + FB_GRAPH_GET_PICTURE_URI,
            qs: { type: 'large', redirect: '0' },
            resolveWithFullResponse: true,
          });
        }
      })
      .then((facebookPictureResult) => {
        // if HTTP request&response successfully.
        if (facebookPictureResult.statusCode === 200) {
          if (JSON.parse(facebookPictureResult.body).data.is_silhouette) {
            result.profile_picture = defaultProfileUrl;
          } else {
            result.profile_picture = JSON.parse(facebookPictureResult.body).data.url;
          }

          resolve(result);
        }
      })
      .catch((err) => {
        reject({ err_point: userCallback.ERR_INVALID_ACCESS_TOKEN });
      });
  });
}

export function editGeneralProfile(req, res, next) {
  validateEmail(req.body.email)
    .then(isValid => setKey())
    .then((keyData) => {
      if (keyData) {
        return User.findOne({ _id: req.user._id }).exec();
      } else {
        throw new Error(userCallback.ERR_AWS_KEY);
      }
    })
    .then((user) => {
      user.name = req.body.name;
      user.email = req.body.email;
      user.languages = req.body.languages;
      user.location = req.body.location;
      user.about = req.body.about;
      user.education = req.body.education;
      user.experience = req.body.experience;

      return user.save();
    })
    .then((updatedUser) => {
      if (req.body.image === '') {
        res.status(200).json({ msg: userCallback.SUCCESS_UPDATE_WITHOUT_IMAGE });
      } else {
        const S3 = new AWS.S3({ region: 'ap-northeast-2' });
        const bucketName = 'yodabucket';
        let now = new Date();
        let imageKey = `profile/${req.user._id}/${now.getTime()}.png`;
        let encondedImage = new Buffer(req.body.image, 'base64');

        let params = {
          Bucket: bucketName,
          Key: imageKey,
          ACL: 'public-read',
          Body: encondedImage,
        };
        S3.putObject(params).promise()
          .then((data, err) => {
            if (data) {
              let profileUrl = `${S3.endpoint.href}${bucketName}/${imageKey}`;
              return updateProfile(req, profileUrl);
            } else {
              throw new Error(userCallback.ERR_AWS);
            }
          })
          .then((success) => {
            if (success) {
              res.status(200).json({ msg: userCallback.SUCCESS_UPDATE });
            } else {
              throw new Error(userCallback.ERR_MONGOOSE);
            }
          })
          .catch((err) => {
            res.status(400).json({ err_msg: err });
          });
      }
    })
    .catch((err) => {
      res.status(400).json(err);
    });
}

function validateEmail(req) {
  return new Promise((resolve, reject) => {
    let email = req;
    let filter = /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/;
    if (filter.test(email)) {
      resolve(true);
    } else {
      reject(new Error(userCallback.ERR_FAIL_REGISTER));
    }
  });
}

function setKey() {
  return new Promise((resolve, reject) => {
    Key.findOne({ name: 'accessKeyId' }).exec()
      .then((accessKeyIdObject) => {
        AWS.config.accessKeyId = accessKeyIdObject.key;
        return Key.findOne({ name: 'secretAccessKey' }).exec();
      })
      .then((secretAccessKeyObject) => {
        AWS.config.secretAccessKey = secretAccessKeyObject.key;
        resolve(true);
      })
      .catch((err) => {
        reject();
      });
  });
}

function updateProfile(req, profileUrl) {
  return new Promise((resolve, reject) => {
    User.update({ _id: req.user._id }, {
      $set: { profile_picture: profileUrl },
    }).exec()
      .then((data) => {
        resolve(data);
      })
      .catch((err) => {
        reject();
      });
  });
}

export function editCareer(req, res, next) {
  User.update({ _id: req.user._id }, {
    $set: {
      career: req.body.career,
    },
  }).exec()
    .then((data) => {
      res.status(200).json({ msg: userCallback.SUCCESS_EDIT });
    })
    .catch((err) => {
      res.status(400).json(err);
    });
}

export function editExpertise(req, res, next) {
  User.update({ _id: req.user._id }, {
    $set: {
      expertise: req.body.expertise,
    },
  }).exec()
    .then((data) => {
      res.status(200).json({ msg: userCallback.SUCCESS_EDIT });
    })
    .catch((err) => {
      res.status(400).json(err);
    });
}

export function editPersonality(req, res, next) {
  User.update({ _id: req.user._id }, {
    $set: {
      personality: req.body.personality,
    },
  }).exec()
    .then((data) => {
      res.status(200).json({ msg: userCallback.SUCCESS_EDIT });
    })
    .catch((err) => {
      res.status(400).json(err);
    });
}

export function getCareerInfo(req, res, next) {
  User.findOne({ _id: req.user._id }).exec()
    .then((user) => {
      res.status(200).json(user.career);
    })
    .catch((err) => {
      res.status(400).json({ err_point: userCallback.ERR_MONGOOSE, err: err });
    });
}

export function getExpertiseInfo(req, res, next) {
  User.findOne({ _id: req.user._id }).exec()
    .then((user) => {
      res.status(200).json(user.expertise);
    })
    .catch((err) => {
      res.status(400).json({ err_point: userCallback.ERR_MONGOOSE, err: err });
    });
}

export function getPersonalityInfo(req, res, next) {
  User.findOne({ _id: req.user._id }).exec()
    .then((user) => {
      res.status(200).json(user.personality);
    })
    .catch((err) => {
      res.status(400).json({ err_point: userCallback.ERR_MONGOOSE, err: err });
    });
}

export function setMentoringRequestStatus(req, res, next) {
  if (req.body.mentorMode === 'true' || req.body.mentorMode === 'false') {
    User.update({ _id: req.user._id }, {
      $set: {
        mentorMode: req.body.mentorMode,
      },
    }).exec()
      .then((update) => {
        res.status(200).json({ msg: userCallback.SUCCESS_UPDATE });
      })
      .catch((err) => {
        res.status(400).json(err);
      });
  } else {
    res.status(400).json({ err_point: userCallback.ERR_INVALID_PARAMS });
  }
}

export function getMentoringRequestStatus(req, res, next) {
  User.findOne({ _id: req.user._id }).exec()
    .then((user) => {
      if (user.mentorMode == null) {
        res.status(200).json(true);
      } else {
        res.status(200).json({ result: user.mentorMode });
      }
    })
    .catch((err) => {
      res.status(400).json(err);
    });
}

export function signOut(req, res, next) {
  User.findOne({ _id: req.user._id }).exec()
    .then((user) => {
      const index = user.deviceToken.indexOf(req.body.deviceToken);
      user.deviceToken.splice(index, 1);
      user.save();
    })
    .then(() => {
      res.status(200).json({ msg: userCallback.SUCCESS_SIGNOUT });
    })
    .catch((err) => {
      res.status(400).json(err);
    });
}
